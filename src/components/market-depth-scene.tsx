import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

type Candle = { o: number; h: number; l: number; c: number };

/** A browser-only, decorative dimensional view of the same candles as the price chart. */
export function MarketDepthScene({ candles }: { candles: Candle[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const container = host.current;
    if (!container || candles.length === 0) return;
    let disposed = false;
    let cleanup = () => {};
    void import("three").then((THREE) => {
      if (disposed) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); } catch { return; }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
      container.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
      camera.position.set(0, 3.8, 10);
      camera.lookAt(0, 0.8, 0);
      const group = new THREE.Group();
      scene.add(group);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 2.6));
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(-3, 6, 6);
      scene.add(light);
      const token = (name: string) => {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return new THREE.Color();
        context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        context.fillRect(0, 0, 1, 1);
        const rgb = context.getImageData(0, 0, 1, 1).data;
        return new THREE.Color(`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
      };
      const up = new THREE.MeshStandardMaterial({ color: token("--gain"), metalness: 0.45, roughness: 0.28 });
      const down = new THREE.MeshStandardMaterial({ color: token("--loss"), metalness: 0.45, roughness: 0.28 });
      const gridMaterial = new THREE.LineBasicMaterial({ color: token("--muted-foreground"), transparent: true, opacity: 0.15 });
      const values = candles.slice(-32);
      const min = Math.min(...values.map(c => c.l));
      const range = Math.max(...values.map(c => c.h)) - min || 1;
      const y = (price: number) => ((price - min) / range) * 4 - 1;
      values.forEach((c, i) => {
        const material = c.c >= c.o ? up : down;
        const x = (i - (values.length - 1) / 2) * 0.47;
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.25, Math.max(0.07, Math.abs(y(c.o) - y(c.c))), 0.32), material);
        body.position.set(x, (y(c.o) + y(c.c)) / 2, 0);
        const wick = new THREE.Mesh(new THREE.BoxGeometry(0.035, Math.max(0.04, y(c.h) - y(c.l)), 0.035), material);
        wick.position.set(x, (y(c.h) + y(c.l)) / 2, 0);
        group.add(body, wick);
      });
      const grid = new THREE.GridHelper(18, 24);
      grid.material = gridMaterial;
      grid.position.y = -1.5;
      group.add(grid);
      const themeObserver = new MutationObserver(() => {
        up.color.copy(token("--gain")); down.color.copy(token("--loss")); gridMaterial.color.copy(token("--muted-foreground"));
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      const resize = new ResizeObserver(() => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.position.z = width < 600 ? 13 : 10;
        camera.updateProjectionMatrix();
      });
      resize.observe(container);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      let pointerX = 0;
      const pointer = (event: PointerEvent) => {
        const bounds = container.getBoundingClientRect();
        pointerX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 0.2;
      };
      container.addEventListener("pointermove", pointer);
      let frame = 0;
      const render = (time: number) => {
        frame = requestAnimationFrame(render);
        if (document.hidden) return;
        if (!reduced.matches && !pausedRef.current) {
          group.rotation.y += (Math.sin(time / 5000) * 0.07 + pointerX - group.rotation.y) * 0.025;
        }
        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(render);
      cleanup = () => {
        cancelAnimationFrame(frame); resize.disconnect(); themeObserver.disconnect();
        container.removeEventListener("pointermove", pointer);
        group.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
        grid.geometry.dispose(); up.dispose(); down.dispose(); gridMaterial.dispose();
        renderer.dispose(); renderer.domElement.remove();
      };
    }).catch(() => {});
    return () => { disposed = true; cleanup(); };
  }, [candles]);

  return (
    <div className="market-scene">
      <div ref={host} className="absolute inset-0" aria-hidden="true" />
      <Button variant="ghost" size="icon-sm" className="absolute right-4 top-3 z-10 text-muted-foreground" aria-label={paused ? "Resume market animation" : "Pause market animation"} title={paused ? "Resume market animation" : "Pause market animation"} onClick={() => setPaused(!paused)}>
        {paused ? <Play /> : <Pause />}
      </Button>
    </div>
  );
}