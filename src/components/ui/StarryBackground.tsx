import { useEffect, useRef } from "react";

/** 星空粒子背景 — 仅在 dark-starry 主题下使用 */
export function StarryBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;

    interface Star {
      x: number;
      y: number;
      r: number;
      speed: number;
      phase: number;
    }

    const stars: Star[] = [];

    function resize() {
      w = canvas!.width = window.innerWidth;
      h = canvas!.height = window.innerHeight;
    }

    function init() {
      resize();
      stars.length = 0;
      const count = Math.floor((w * h) / 18000); // ~60 on 1080p
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.2 + 0.4,
          speed: Math.random() * 0.5 + 0.3,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }

    function draw(time: number) {
      ctx!.clearRect(0, 0, w, h);

      // 绘制光晕
      const g1 = ctx!.createRadialGradient(w * 0.8, h * 0.1, 0, w * 0.8, h * 0.1, 300);
      g1.addColorStop(0, "rgba(124,58,237,0.06)");
      g1.addColorStop(1, "transparent");
      ctx!.fillStyle = g1;
      ctx!.fillRect(0, 0, w, h);

      const g2 = ctx!.createRadialGradient(w * 0.15, h * 0.85, 0, w * 0.15, h * 0.85, 250);
      g2.addColorStop(0, "rgba(6,182,212,0.04)");
      g2.addColorStop(1, "transparent");
      ctx!.fillStyle = g2;
      ctx!.fillRect(0, 0, w, h);

      // 绘制星星
      for (const s of stars) {
        const t = time * 0.001 * s.speed;
        const alpha = 0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t + s.phase));
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(167,139,250,${alpha})`;
        ctx!.fill();
      }

      animRef.current = requestAnimationFrame(draw);
    }

    init();
    animRef.current = requestAnimationFrame(draw);

    window.addEventListener("resize", init);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", init);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}
