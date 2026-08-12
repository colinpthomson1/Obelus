/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveSelectionRequest } from './ipcTypes';
import { transcriptSelectionFactCheckInputAtAnchor } from './manualFactCheckSelection';
import type { MeetingArtifact, TranscriptTurn } from './types';

function turn(id: string, text: string, patch: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    id,
    meetingId: 'meeting-1',
    transcriptVersionId: 'live-version',
    provider: 'faster_whisper',
    providerSessionId: 'local-session',
    providerTurnId: id,
    providerTurnOrder: 1,
    revision: 1,
    status: 'revised',
    speakerId: 'speaker-1',
    sourceKind: 'mixed',
    startMs: 27_000,
    endMs: 29_940,
    text,
    words: [],
    utteranceBoundary: true,
    endOfTurn: true,
    formatted: true,
    receivedAtMs: 30_000,
    ...patch,
  };
}

function selection(text: string): LiveSelectionRequest {
  return {
    text,
    source: 'context-menu',
    capturedAtEpochMs: 1_000,
    anchor: { x: 80, y: 120 },
  };
}

function artifact(turns: TranscriptTurn[]): MeetingArtifact {
  return {
    id: 'meeting-1',
    turns,
  } as MeetingArtifact;
}

function pointAt(element: HTMLElement): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => element,
  });
}

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('transcriptSelectionFactCheckInputAtAnchor', () => {
  it('recovers a canonical substring from a finalized active turn after the native Range is lost', () => {
    const activeTurn = turn(
      'turn-live',
      'Earth, Barnes and Noble is a bigger company than Amazon.'
    );
    document.body.innerHTML = `
      <div data-turn-id="${activeTurn.id}">
        <p data-transcript-text><span id="selected-row">${activeTurn.text}</span></p>
      </div>
    `;
    pointAt(document.querySelector<HTMLElement>('#selected-row')!);

    expect(
      transcriptSelectionFactCheckInputAtAnchor(
        selection('Barnes & Noble is a bigger company than Amazon.'),
        { artifact: artifact([]), activeTurns: { current: activeTurn } }
      )
    ).toEqual({
      text: 'Barnes & Noble is a bigger company than Amazon.',
      turnIds: [activeTurn.id],
      speakerId: activeTurn.speakerId,
      startMs: activeTurn.startMs,
      endMs: activeTurn.endMs,
      nearbyContext: activeTurn.text,
      anchor: { x: 80, y: 120 },
    });
  });

  it('uses the actual refined segment shown in a finalized artifact view', () => {
    const liveTurn = turn('turn-live', 'Revenue rose by ten percent.');
    const refinedTurn = turn('turn-refined', 'Revenue rose by 10%.', {
      transcriptVersionId: 'refined-version',
    });
    document.body.innerHTML = `
      <div data-turn-id="${refinedTurn.id}">
        <p data-transcript-text id="refined-row">${refinedTurn.text}</p>
      </div>
    `;
    pointAt(document.querySelector<HTMLElement>('#refined-row')!);

    expect(
      transcriptSelectionFactCheckInputAtAnchor(selection('Revenue rose by 10%.'), {
        artifact: artifact([liveTurn, refinedTurn]),
        activeTurns: {},
      })
    ).toMatchObject({
      text: 'Revenue rose by 10%.',
      turnIds: [refinedTurn.id],
      startMs: refinedTurn.startMs,
      endMs: refinedTurn.endMs,
    });
  });

  it('recovers a collapsed cross-row selection from bounded contiguous turns', () => {
    const first = turn('turn-first', 'Barnes & Noble is a bigger', {
      providerTurnOrder: 1,
      startMs: 27_000,
      endMs: 28_400,
    });
    const second = turn('turn-second', 'company than Amazon.', {
      providerTurnOrder: 2,
      startMs: 28_400,
      endMs: 29_940,
    });
    document.body.innerHTML = `
      <div data-turn-id="${first.id}"><p data-transcript-text>${first.text}</p></div>
      <div data-turn-id="${second.id}">
        <p data-transcript-text id="second-row">${second.text}</p>
      </div>
    `;
    pointAt(document.querySelector<HTMLElement>('#second-row')!);

    expect(
      transcriptSelectionFactCheckInputAtAnchor(
        selection('Barnes & Noble is a bigger company than Amazon.'),
        { artifact: artifact([]), activeTurns: { first, second } }
      )
    ).toMatchObject({
      text: 'Barnes & Noble is a bigger company than Amazon.',
      turnIds: [first.id, second.id],
      startMs: first.startMs,
      endMs: second.endMs,
      nearbyContext: 'Barnes & Noble is a bigger company than Amazon.',
    });
  });

  it('denies repeated and ambiguous transcript matches', () => {
    const repeated = turn('turn-repeated', 'Alpha beta. Alpha beta.');
    document.body.innerHTML = `
      <div data-turn-id="${repeated.id}">
        <p data-transcript-text id="repeated-row">${repeated.text}</p>
      </div>
    `;
    pointAt(document.querySelector<HTMLElement>('#repeated-row')!);
    expect(
      transcriptSelectionFactCheckInputAtAnchor(selection('Alpha beta.'), {
        artifact: artifact([repeated]),
        activeTurns: {},
      })
    ).toBeUndefined();

    const previous = turn('turn-previous', 'Alpha', {
      providerTurnOrder: 1,
      startMs: 1_000,
      endMs: 1_900,
    });
    const anchor = turn('turn-anchor', 'Beta Alpha', {
      providerTurnOrder: 2,
      startMs: 2_000,
      endMs: 2_900,
    });
    const next = turn('turn-next', 'Beta', {
      providerTurnOrder: 3,
      startMs: 3_000,
      endMs: 3_900,
    });
    document.body.innerHTML = `
      <div data-turn-id="${anchor.id}">
        <p data-transcript-text id="ambiguous-row">${anchor.text}</p>
      </div>
    `;
    pointAt(document.querySelector<HTMLElement>('#ambiguous-row')!);
    expect(
      transcriptSelectionFactCheckInputAtAnchor(selection('Alpha Beta'), {
        artifact: artifact([previous, anchor, next]),
        activeTurns: {},
      })
    ).toBeUndefined();
  });

  it('does not attach an outside or mismatched selection to transcript history', () => {
    const transcriptTurn = turn('turn-live', 'A selected claim.');
    document.body.innerHTML = `
      <div data-turn-id="${transcriptTurn.id}">
        <p data-transcript-text id="transcript-row">${transcriptTurn.text}</p>
      </div>
      <p id="outside">A selected claim.</p>
    `;
    pointAt(document.querySelector<HTMLElement>('#outside')!);
    expect(
      transcriptSelectionFactCheckInputAtAnchor(selection('A selected claim.'), {
        artifact: artifact([transcriptTurn]),
        activeTurns: {},
      })
    ).toBeUndefined();

    pointAt(document.querySelector<HTMLElement>('#transcript-row')!);
    expect(
      transcriptSelectionFactCheckInputAtAnchor(selection('Private text outside the transcript.'), {
        artifact: artifact([transcriptTurn]),
        activeTurns: {},
      })
    ).toBeUndefined();
  });

  it('does not create a durable anchor for a partial turn', () => {
    const partialTurn = turn('turn-partial', 'This sentence is still changing', {
      status: 'partial',
    });
    document.body.innerHTML = `
      <div data-turn-id="${partialTurn.id}">
        <p data-transcript-text id="partial-row">${partialTurn.text}</p>
      </div>
    `;
    pointAt(document.querySelector<HTMLElement>('#partial-row')!);

    expect(
      transcriptSelectionFactCheckInputAtAnchor(selection(partialTurn.text), {
        artifact: artifact([]),
        activeTurns: { current: partialTurn },
      })
    ).toBeUndefined();
  });
});
