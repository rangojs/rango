"use client";

import { useEffect, useState } from "react";

interface Star {
  id: number;
  top: number;
  left: number;
  angle: number;
  duration: number;
  length: number;
}

export function ShootingStars() {
  const [stars, setStars] = useState<Star[]>([]);

  useEffect(() => {
    let id = 0;
    let timeout: ReturnType<typeof setTimeout>;

    function spawnStar() {
      const star: Star = {
        id: id++,
        top: Math.random() * 40,
        left: 30 + Math.random() * 60,
        angle: -(25 + Math.random() * 20),
        duration: 0.6 + Math.random() * 0.6,
        length: 80 + Math.random() * 120,
      };

      setStars((prev) => [...prev, star]);

      setTimeout(() => {
        setStars((prev) => prev.filter((s) => s.id !== star.id));
      }, star.duration * 1000 + 200);

      timeout = setTimeout(spawnStar, 14000 + Math.random() * 8000);
    }

    timeout = setTimeout(spawnStar, 2000 + Math.random() * 5000);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {stars.map((star) => (
        <div
          key={star.id}
          className="absolute"
          style={{
            top: `${star.top}%`,
            left: `${star.left}%`,
            transform: `rotate(${star.angle}deg)`,
          }}
        >
          <div
            style={{
              animation: `shooting-star ${star.duration}s linear forwards`,
            }}
          >
            <div
              className="h-px bg-gradient-to-l from-white/0 via-white/70 to-white"
              style={{ width: star.length }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
