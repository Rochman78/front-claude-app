import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error) {
    console.error('[plugin] ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="plugin-error" style={{ margin: '12px 16px' }}>
          <p>Erreur : {this.state.error}</p>
          <button onClick={() => this.setState({ hasError: false, error: '' })}>
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
