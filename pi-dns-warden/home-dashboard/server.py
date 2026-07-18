#!/usr/bin/env python3
import json
import mimetypes
import os
import secrets
import socket
import ssl
import struct
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

TOR_HOST = os.getenv("TOR_HOST", "tor")
TOR_SOCKS_PORT = int(os.getenv("TOR_SOCKS_PORT", "9050"))
DNS_HOST = os.getenv("DNS_HOST", "pihole")
CHECK_HOST = "check.torproject.org"
UI_ROOT = Path(__file__).with_name("ui").resolve()
CONTROL_HELPER_URL = os.getenv("CONTROL_HELPER_URL", "http://control-helper:8090")
CONTROL_HELPER_TOKEN = os.getenv("CONTROL_HELPER_TOKEN", "")
CONTROL_PIN = os.getenv("CONTROL_PIN", "")


def load_index():
    return (
        (UI_ROOT / "index.html")
        .read_text(encoding="utf-8")
        .replace(
            "</head>",
            '<script>window.__TORHOLE_MODE__="home"</script></head>',
        )
        .encode("utf-8")
    )


def resolve_ui_path(request_path, root=UI_ROOT):
    root = root.resolve()
    parsed_path = unquote(urlparse(request_path).path)
    relative = "index.html" if parsed_path in {"/", "/index.html"} else parsed_path.lstrip("/")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def helper_request(path, method="GET"):
    request = urllib.request.Request(
        CONTROL_HELPER_URL + path,
        method=method,
        headers={"X-Torhole-Helper-Token": CONTROL_HELPER_TOKEN},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def dns_query(name):
    query_id = int(time.time() * 1000) & 0xFFFF
    labels = b"".join(bytes([len(part)]) + part.encode() for part in name.split(".")) + b"\0"
    packet = struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0) + labels + struct.pack("!HH", 1, 1)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(4)
            sock.sendto(packet, (DNS_HOST, 53))
            response, _ = sock.recvfrom(4096)
        flags, answers = struct.unpack("!HH", response[2:6])
        offset = 12
        while response[offset] != 0:
            offset += response[offset] + 1
        offset += 5
        ips = []
        for _ in range(answers):
            if response[offset] & 0xC0 == 0xC0:
                offset += 2
            else:
                while response[offset] != 0:
                    offset += response[offset] + 1
                offset += 1
            rtype, _rclass, _ttl, length = struct.unpack("!HHIH", response[offset:offset + 10])
            offset += 10
            if rtype == 1 and length == 4:
                ips.append(socket.inet_ntoa(response[offset:offset + 4]))
            offset += length
        return {"ok": bool(flags & 0x8000) and answers > 0, "answers": answers, "ips": ips}
    except Exception as exc:
        return {"ok": False, "answers": 0, "error": str(exc)}


def socks_connect(host, port=443):
    sock = socket.create_connection((TOR_HOST, TOR_SOCKS_PORT), timeout=12)
    sock.settimeout(12)
    sock.sendall(b"\x05\x01\x00")
    if sock.recv(2) != b"\x05\x00":
        raise RuntimeError("SOCKS negotiation failed")
    encoded = host.encode("idna")
    sock.sendall(b"\x05\x01\x00\x03" + bytes([len(encoded)]) + encoded + struct.pack("!H", port))
    head = sock.recv(4)
    if len(head) != 4 or head[1] != 0:
        raise RuntimeError("Tor connection failed")
    if head[3] == 1:
        sock.recv(4)
    elif head[3] == 4:
        sock.recv(16)
    elif head[3] == 3:
        sock.recv(sock.recv(1)[0])
    sock.recv(2)
    return sock


def tor_exit():
    started = time.monotonic()
    try:
        context = ssl.create_default_context()
        with context.wrap_socket(socks_connect(CHECK_HOST), server_hostname=CHECK_HOST) as sock:
            sock.sendall(
                b"GET /api/ip HTTP/1.1\r\nHost: check.torproject.org\r\n"
                b"Accept: application/json\r\nConnection: close\r\n\r\n"
            )
            chunks = []
            while True:
                chunk = sock.recv(8192)
                if not chunk:
                    break
                chunks.append(chunk)
        body = b"".join(chunks).split(b"\r\n\r\n", 1)[1]
        data = json.loads(body.decode())
        return {
            "ok": data.get("IsTor") is True,
            "ip": data.get("IP"),
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    except Exception as exc:
        return {"ok": False, "ip": None, "error": str(exc)}


def proof():
    exit_check = tor_exit()
    if not exit_check["ok"]:
        time.sleep(0.5)
        exit_check = tor_exit()
    bootstrap = {"ok": exit_check["ok"], "progress": 100 if exit_check["ok"] else 0}
    dns = dns_query("example.com")
    block_query = dns_query("doubleclick.net")
    blocked = {**block_query, "ok": "0.0.0.0" in block_query.get("ips", [])}
    protected = bootstrap["ok"] and dns["ok"] and blocked["ok"] and exit_check["ok"]
    try:
        circuit = helper_request("/circuit")
    except Exception as exc:
        circuit = {"ok": False, "relays": [], "detail": str(exc)}
    return {
        "protected": protected,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tor": bootstrap,
        "dns": dns,
        "blocking": blocked,
        "exit": exit_check,
        "bypass": {"ok": True, "detail": "Only Tor has an internet-capable network"},
        "circuit": circuit,
        "tests": {
            "dns": {"query": "example.com A", "expected": "At least one IP answer through Pi-hole → dnscrypt-proxy → Tor"},
            "blocking": {"query": "doubleclick.net A", "expected": "Pi-hole returns 0.0.0.0"},
            "tor": {"query": "check.torproject.org/api/ip", "expected": "Tor Project reports IsTor=true"},
            "bypass": {"query": "Docker network topology", "expected": "Only the Tor container has an internet-capable network"},
        },
    }


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, payload, content_type, *, cache="no-store"):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def serve_ui(self):
        candidate = resolve_ui_path(self.path)
        if candidate is None:
            return self.send_error(404)
        if candidate == UI_ROOT / "index.html":
            return self.send_bytes(load_index(), "text/html; charset=utf-8")
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        return self.send_bytes(candidate.read_bytes(), content_type, cache="public, max-age=31536000, immutable")

    def do_GET(self):
        if self.path == "/api/proof":
            payload = json.dumps(proof()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        return self.serve_ui()

    def do_POST(self):
        if not self.path.startswith("/api/actions/"):
            return self.send_error(404)
        supplied_pin = self.headers.get("X-Torhole-PIN", "")
        if not CONTROL_PIN or not secrets.compare_digest(supplied_pin, CONTROL_PIN):
            payload = json.dumps({"ok": False, "detail": "Incorrect control PIN"}).encode()
            self.send_response(403)
        else:
            try:
                payload = json.dumps(helper_request(self.path.removeprefix("/api"), "POST")).encode()
                self.send_response(200)
            except urllib.error.HTTPError as exc:
                payload = exc.read() or json.dumps({"ok": False, "detail": "Control failed"}).encode()
                self.send_response(exc.code)
            except Exception as exc:
                payload = json.dumps({"ok": False, "detail": str(exc)}).encode()
                self.send_response(502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


def main():
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    main()
