import { useEffect, useRef } from "react";
import * as THREE from "three";

/** A deliberately small Three.js scene: DNS packets enter Tor, orbit through
 * an anonymising relay ring, then leave through an exit node. It is a live
 * status illustration, not a decorative particle field. */
export default function PrivacyFlowCanvas({ active }: { active: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0, 8);
    renderer.setClearAlpha(0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute("aria-hidden", "true");
    mount.appendChild(renderer.domElement);

    const group = new THREE.Group();
    group.rotation.x = -0.12;
    scene.add(group);

    const css = getComputedStyle(document.documentElement);
    const primary = new THREE.Color(css.getPropertyValue("--color-th-primary").trim() || "#22c55e");
    const muted = new THREE.Color(css.getPropertyValue("--color-th-text-muted").trim() || "#94a3b8");
    const danger = new THREE.Color(css.getPropertyValue("--color-th-danger").trim() || "#ef4444");
    const signal = active ? primary : danger;

    const nodeGeometry = new THREE.IcosahedronGeometry(0.28, 2);
    const nodeMaterial = new THREE.MeshBasicMaterial({ color: signal, wireframe: true, transparent: true, opacity: 0.78 });
    const entry = new THREE.Mesh(nodeGeometry, nodeMaterial);
    entry.position.set(-2.8, -0.4, 0);
    const exit = new THREE.Mesh(nodeGeometry, nodeMaterial.clone());
    exit.position.set(2.8, 0.45, 0);
    group.add(entry, exit);

    const torGeometry = new THREE.TorusGeometry(1.15, 0.022, 8, 96);
    const torMaterial = new THREE.MeshBasicMaterial({ color: signal, transparent: true, opacity: 0.45 });
    const torRing = new THREE.Mesh(torGeometry, torMaterial);
    torRing.rotation.x = 0.78;
    torRing.rotation.y = -0.18;
    group.add(torRing);

    const relayMaterial = new THREE.MeshBasicMaterial({ color: muted, transparent: true, opacity: 0.62 });
    for (let index = 0; index < 5; index += 1) {
      const relay = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 10), relayMaterial);
      const angle = (index / 5) * Math.PI * 2;
      relay.position.set(Math.cos(angle) * 1.15, Math.sin(angle) * 0.78, Math.sin(angle) * 0.34);
      group.add(relay);
    }

    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-3.15, -0.4, 0),
      new THREE.Vector3(-1.45, -0.65, 0.25),
      new THREE.Vector3(-0.4, 0.72, -0.3),
      new THREE.Vector3(0.65, -0.65, 0.35),
      new THREE.Vector3(1.55, 0.5, -0.1),
      new THREE.Vector3(3.15, 0.45, 0),
    ]);
    const path = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(100)),
      new THREE.LineBasicMaterial({ color: signal, transparent: true, opacity: 0.23 }),
    );
    group.add(path);

    const packetGeometry = new THREE.SphereGeometry(0.055, 10, 10);
    const packets = Array.from({ length: 7 }, (_, index) => {
      const packet = new THREE.Mesh(
        packetGeometry,
        new THREE.MeshBasicMaterial({ color: signal, transparent: true, opacity: 0.9 - index * 0.07 }),
      );
      group.add(packet);
      return packet;
    });

    let frame = 0;
    let elapsed = 0;
    let visible = !document.hidden;
    const clock = new THREE.Clock();

    const resize = () => {
      const width = Math.max(mount.clientWidth, 1);
      const height = Math.max(mount.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    const render = () => {
      if (!visible) return;
      elapsed += Math.min(clock.getDelta(), 0.05);
      torRing.rotation.z = elapsed * 0.16;
      entry.rotation.y = elapsed * 0.45;
      exit.rotation.x = elapsed * 0.38;
      packets.forEach((packet, index) => {
        const position = curve.getPoint((elapsed * 0.115 + index / packets.length) % 1);
        packet.position.copy(position);
        packet.scale.setScalar(0.75 + Math.sin(elapsed * 4 + index) * 0.18);
      });
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) {
        clock.getDelta();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(render);
      } else {
        cancelAnimationFrame(frame);
      }
    };
    const onTheme = () => {
      const nextCss = getComputedStyle(document.documentElement);
      const next = new THREE.Color(
        active
          ? nextCss.getPropertyValue("--color-th-primary").trim() || "#22c55e"
          : nextCss.getPropertyValue("--color-th-danger").trim() || "#ef4444",
      );
      nodeMaterial.color.copy(next);
      (exit.material as THREE.MeshBasicMaterial).color.copy(next);
      torMaterial.color.copy(next);
      (path.material as THREE.LineBasicMaterial).color.copy(next);
      packets.forEach((packet) => (packet.material as THREE.MeshBasicMaterial).color.copy(next));
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("torhole-theme", onTheme);
    render();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("torhole-theme", onTheme);
      group.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose();
          const material = object.material;
          (Array.isArray(material) ? material : [material]).forEach((item) => item.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [active]);

  return <div ref={mountRef} className="absolute inset-y-0 right-0 w-[58%] opacity-70 [mask-image:linear-gradient(to_right,transparent,black_28%)]" aria-hidden="true" />;
}
