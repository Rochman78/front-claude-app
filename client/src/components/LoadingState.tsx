import { useState, useEffect } from 'react';

interface LoadingStateProps {
  message?: string;
  progressive?: boolean;
}

const PROGRESSIVE_STEPS = [
  { text: 'Lecture du mail...', delay: 0 },
  { text: 'Consultation des documents...', delay: 1000 },
  { text: 'Rédaction du brouillon...', delay: 3000 },
];

export default function LoadingState({ message = 'Chargement...', progressive = false }: LoadingStateProps) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!progressive) return;

    const timers = PROGRESSIVE_STEPS.slice(1).map((step, i) =>
      setTimeout(() => setStepIndex(i + 1), step.delay)
    );

    return () => timers.forEach(clearTimeout);
  }, [progressive]);

  const displayText = progressive ? PROGRESSIVE_STEPS[stepIndex].text : message;

  return (
    <div className="loading-state">
      <div className="loading-spinner" />
      <p>{displayText}</p>
    </div>
  );
}
