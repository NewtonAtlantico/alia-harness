import type { ReactNode } from 'react';
import type { Interaction, InteractionResponse } from '../../../shared/ipc';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';

/**
 * Whatever is waiting for the user in the view being shown. The oldest one is the card; the others queue behind it
 * (a count on the card), and appear one by one as each is answered. `renderQuestions` lets a screen draw the model's
 * questions its own way (the pipeline's gate card) while the plumbing stays the same.
 */
export function InteractionCards({
  interactions,
  defaultOwner,
  onRespond,
  renderQuestions,
}: {
  interactions: Interaction[];
  defaultOwner: string;
  onRespond: (id: string, response: InteractionResponse) => void;
  renderQuestions?: (interaction: Extract<Interaction, { kind: 'ask_user' }>, answer: (answers: Extract<InteractionResponse, { answers: unknown }>['answers']) => void, queued: number) => ReactNode;
}) {
  const [active, ...rest] = interactions;
  if (!active) return null;
  if (active.kind === 'permission') {
    return <PermissionCard key={active.id} interaction={active} queued={rest.length} onDecide={(decision) => onRespond(active.id, { decision })} />;
  }
  const answer = (answers: Extract<InteractionResponse, { answers: unknown }>['answers']) => onRespond(active.id, { answers });
  return <>{renderQuestions ? renderQuestions(active, answer, rest.length) : <QuestionCard key={active.id} interaction={active} queued={rest.length} defaultOwner={defaultOwner} onAnswer={answer} />}</>;
}
