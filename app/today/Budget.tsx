"use client";

import { useTransition } from "react";

import { setDailyMinutes } from "@/app/today/actions";

const CHOICES = [20, 30, 45, 60, 90, 120, 180, 240];

export function Budget({ minutes }: { minutes: number }) {
  const [pending, start] = useTransition();
  const choices = CHOICES.includes(minutes) ? CHOICES : [...CHOICES, minutes].sort((a, b) => a - b);
  return (
    <label className="today-budget">
      <span>I have</span>
      <select value={minutes} disabled={pending} onChange={(e) => start(() => setDailyMinutes(Number(e.target.value)))} aria-label="Time to study today">
        {choices.map((m) => (
          <option key={m} value={m}>
            {m < 60 ? `${m} minutes` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} hour${m === 60 ? "" : "s"}`}
          </option>
        ))}
      </select>
      <span>today</span>
    </label>
  );
}
