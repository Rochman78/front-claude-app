interface LoadingStateProps {
  message?: string;
}

export default function LoadingState({ message = 'Chargement...' }: LoadingStateProps) {
  return (
    <div className="loading-state">
      <div className="loading-spinner" />
      <p>{message}</p>
    </div>
  );
}
