#!/usr/bin/env python3
import http.client
import json
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["CONTROL_HELPER_TOKEN"]
DOCKER_SOCKET = "/var/run/docker.sock"
TOR_SOCKET = "/var/lib/tor/control.sock"
ALLOWED = {
    "restart-tor": ("restart", "torhole-qs-tor"),
    "restart-dns": ("restart", "torhole-qs-dnscrypt"),
    "restart-protection": ("restart-many", None),
    "stop-protection": ("stop-many", None),
    "start-protection": ("start-many", None),
}
CONTAINERS = ("torhole-qs-tor", "torhole-qs-dnscrypt", "torhole-qs-pihole")


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect(DOCKER_SOCKET)


def docker_post(container, operation):
    conn = UnixHTTPConnection("localhost")
    conn.request("POST", f"/v1.41/containers/{container}/{operation}?t=15")
    response = conn.getresponse()
    response.read()
    conn.close()
    if response.status not in (204, 304):
        raise RuntimeError(f"Docker returned {response.status}")


def tor_command(*commands):
    cookie = open("/var/lib/tor/control.authcookie", "rb").read().hex()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as control:
        control.settimeout(5)
        control.connect(TOR_SOCKET)
        payload = [f"AUTHENTICATE {cookie}", *commands, "QUIT"]
        control.sendall(("\r\n".join(payload) + "\r\n").encode())
        chunks = []
        while True:
            part = control.recv(65536)
            if not part:
                break
            chunks.append(part)
    text = b"".join(chunks).decode(errors="replace")
    if "515 Authentication failed" in text or "5" in text[:1]:
        raise RuntimeError("Tor control command failed")
    return text


def parse_circuit():
    text = tor_command("GETINFO circuit-status")
    lines = text.splitlines()
    established = next(
        (line for line in lines if " BUILT " in line and "PURPOSE=GENERAL" in line
         and len(line.split()) > 2 and line.split()[2].count(",") >= 2),
        None,
    )
    if not established:
        return {"ok": False, "relays": [], "detail": "Tor is building a circuit"}
    path = established.split()[2].split(",")
    relays = []
    roles = ("Guard", "Middle", "Exit")
    for index, item in enumerate(path):
        fingerprint, _, nickname = item.partition("~")
        fingerprint = fingerprint.lstrip("$")
        relay = {"role": roles[index] if index < 2 else ("Exit" if index == len(path) - 1 else "Middle"),
                 "nickname": nickname or "Unnamed", "fingerprint": fingerprint}
        try:
            ns = tor_command(f"GETINFO ns/id/{fingerprint}")
            rline = next(line for line in ns.splitlines() if line.startswith("r "))
            parts = rline.split()
            relay["address"] = parts[6]
            country = tor_command(f"GETINFO ip-to-country/{parts[6]}")
            marker = f"250-ip-to-country/{parts[6]}="
            relay["country"] = next((line[len(marker):].upper() for line in country.splitlines() if line.startswith(marker)), "??")
        except Exception:
            relay["country"] = "??"
        relays.append(relay)
    return {"ok": True, "relays": relays}


class Handler(BaseHTTPRequestHandler):
    def authorized(self):
        return self.headers.get("X-Torhole-Helper-Token") == TOKEN

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authorized():
            return self.reply(403, {"ok": False})
        if self.path == "/circuit":
            try:
                return self.reply(200, parse_circuit())
            except Exception as exc:
                return self.reply(200, {"ok": False, "relays": [], "detail": str(exc)})
        self.reply(404, {"ok": False})

    def do_POST(self):
        if not self.authorized():
            return self.reply(403, {"ok": False})
        action = self.path.removeprefix("/actions/")
        try:
            if action == "new-identity":
                tor_command("SIGNAL NEWNYM")
                return self.reply(200, {"ok": True, "detail": "Tor accepted the new identity request. New connections will use fresh circuits."})
            if action not in ALLOWED:
                return self.reply(404, {"ok": False, "detail": "Unknown action"})
            operation, container = ALLOWED[action]
            if operation in ("restart",):
                docker_post(container, operation)
            else:
                verb = operation.split("-")[0]
                targets = tuple(reversed(CONTAINERS)) if verb == "stop" else CONTAINERS
                for target in targets:
                    docker_post(target, verb)
            self.reply(200, {"ok": True, "detail": "Action completed"})
        except Exception as exc:
            self.reply(500, {"ok": False, "detail": str(exc)})

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
