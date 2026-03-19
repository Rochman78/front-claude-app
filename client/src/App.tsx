import { useFrontContext } from './providers/FrontContext';
import PluginMain from './components/PluginMain';
import LoadingState from './components/LoadingState';

export default function App() {
  const context = useFrontContext();

  if (!context) {
    return <LoadingState message="Connexion à Front App..." />;
  }

  switch (context.type) {
    case 'noConversation':
      return (
        <div className="plugin-empty">
          <p>Sélectionnez une conversation pour utiliser le plugin Zephyr.</p>
        </div>
      );
    case 'singleConversation':
      return <PluginMain context={context} />;
    case 'multiConversations':
      return (
        <div className="plugin-empty">
          <p>Sélectionnez une seule conversation.</p>
        </div>
      );
    default:
      return (
        <div className="plugin-empty">
          <p>Contexte non supporté.</p>
        </div>
      );
  }
}
