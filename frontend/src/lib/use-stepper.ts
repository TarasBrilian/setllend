import { useEffect, useState } from "react";

/** Simulated step progress (D47): null until started, then one step every 1.2 s up to `count`. */
export function useStepper(count: number) {
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    if (step === null || step >= count) return;
    const timer = setTimeout(() => setStep(step + 1), 1200);
    return () => clearTimeout(timer);
  }, [step, count]);
  return { step, start: () => setStep(0), reset: () => setStep(null) };
}
