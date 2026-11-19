import { useCallback, useEffect, useReducer } from 'react';
import type { InteractionResponse } from '../../../shared/ipc';
import { reducePending } from '../lib/interactions';

/**
 * Everything waiting for an answer, across every conversation: the engine pushes approvals and questions, closes them
 * when a run is cancelled or ends, and tells us if it restarted (then what was waiting is gone). On load it is asked
 * what is pending, so a reloaded page shows the cards again.
 */
export function useInteractions() {
  const [pending, dispatch] = useReducer(reducePending, []);

  useEffect(() => {
    const load = () => window.alia.request('interaction.pending', {}).then((interactions) => dispatch({ type: 'reset', interactions }), () => {});
    void load();
    return window.alia.onMessage((message) => {
      dispatch({ type: 'push', message });
      if (message.kind === 'engine_status' && message.status === 'restarted') void load();
    });
  }, []);

  /** Answers one. The card goes away at once; if the engine says it was already closed, there is nothing more to do. */
  const respond = useCallback(async (id: string, response: InteractionResponse) => {
    dispatch({ type: 'remove', id });
    await window.alia.request('interaction.respond', { id, response }).catch(() => {});
  }, []);

  return { pending, respond };
}
