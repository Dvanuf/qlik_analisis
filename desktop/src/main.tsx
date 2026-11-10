import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден #root');

/**
 * Error boundary: падение любой вкладки больше не делает окно пустым.
 * Вместо белого экрана — текст ошибки и кнопка перезагрузки интерфейса.
 */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: 32, fontFamily: 'inherit', color: 'var(--text, #e9ebee)' }}>
          <h2 style={{ color: 'var(--danger, #ff6b6b)' }}>Интерфейс упал с ошибкой</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--muted, #9aa2ac)' }}>
            {error.message}
            {'\n\n'}
            {error.stack?.slice(0, 1200)}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); }}
            style={{ padding: '8px 14px', cursor: 'pointer' }}
          >
            Перезагрузить интерфейс
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(container).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
