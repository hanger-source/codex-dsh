// Read native execution evidence; do not schedule, poll or diagnose Agents.
import { readActivity, readState } from './session.mjs';

function excerpt(text, maxChars) {
  return { text: text.slice(0, maxChars), chars: text.length, truncated: text.length > maxChars };
}

function contentText(content) {
  return (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function position(event) {
  return { seq: event.seq, time: event.time, type: event.type };
}

/**
 * Project one native history page. Input/result excerpts retain their event
 * locations; callers can read details or an earlier page without another scan.
 * A missing return is an observation, not proof that a tool is still executing.
 */
export function summarizeExecution(page, { maxChars = 600 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('maxChars 必须为正整数。');
  const events = page.records.map(record => record.event).toSorted((a, b) => a.seq - b.seq);
  const calls = [];
  let turn = null;
  let lastMessage = null;
  let lastEvent = null;
  const findCall = (id, turnId) => calls.findLast(call => call.callId === id
    && (turnId === undefined || call.turn === turnId));

  for (const event of events) {
    const data = event.data ?? {};
    if (['turn/start', 'turn/end'].includes(event.type)) {
      turn = { ...position(event), turn: data.turn, reason: data.reason };
      if (event.type === 'turn/end') {
        for (const call of calls) {
          if (call.returned || call.closedBy) continue;
          // Nested dispatches inherit the enclosing root's turn where visible.
          // If the page starts inside that turn, its terminal event still ends it.
          if (call.turn === data.turn || call.turn === undefined) call.closedBy = position(event);
        }
      }
    }

    if (event.type === 'tool/call' || event.type === 'tool/code-dispatch-start') {
      const nested = event.type === 'tool/code-dispatch-start';
      const root = nested ? findCall(data.rootCallId) : null;
      calls.push({
        callId: nested ? data.subCallId : data.callId, name: data.name,
        ...(nested ? { rootCallId: data.rootCallId, parentCallId: data.parentCallId } : {}),
        turn: nested ? root?.turn ?? (turn?.type === 'turn/start' ? turn.turn : undefined) : data.turn,
        step: nested ? root?.step : data.step,
        started: position(event),
        input: excerpt(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments) ?? '', maxChars),
        returned: null, closedBy: null,
      });
    }

    if (event.type === 'tool/result' || event.type === 'tool/code-dispatch') {
      const nested = event.type === 'tool/code-dispatch';
      const result = nested ? data : data.message;
      const callId = nested ? data.subCallId : result?.callId;
      // Native top-level results cite their actual call event. Do not pair by name.
      let call = !nested && event.sourceEventSeqs?.length
        ? calls.findLast(item => event.sourceEventSeqs.includes(item.started?.seq))
        : findCall(callId, nested ? undefined : data.turn);
      if (!call) {
        call = { callId, name: nested ? data.name : null,
          ...(nested ? { rootCallId: data.rootCallId, parentCallId: data.parentCallId } : {}),
          turn: data.turn, step: data.step, started: null, input: nested
            ? excerpt(JSON.stringify(data.arguments) ?? '', maxChars) : null,
          returned: null, closedBy: null };
        calls.push(call);
      }
      call.returned = { ...position(event), isError: result?.isError ?? null,
        output: excerpt(contentText(result?.content), maxChars),
        contentTypes: [...new Set((result?.content ?? []).map(block => block.type))] };
      // run_code drains nested dispatches before returning. Preserve missing child
      // results explicitly, without reporting them as ongoing waits.
      for (const child of calls) {
        if (!child.returned && !child.closedBy
          && (child.parentCallId === callId || child.rootCallId === callId)) child.closedBy = position(event);
      }
    }

    if (event.type === 'assistant/message' || event.type === 'user/message') {
      const content = event.type === 'assistant/message' ? data.message?.content : data.content;
      const text = contentText(content);
      if (text) lastMessage = { ...position(event), text: excerpt(text, maxChars) };
    }
    // Stream fragments/reasoning/usage are not useful execution summaries.
    if (/^(tool\/|turn\/|step\/|approval\/|llm\/retry|agent\/inbox\/)/u.test(event.type)
      || ['assistant/message', 'user/message'].includes(event.type)) lastEvent = position(event);
  }
  return {
    cursor: page.cursor, hasMore: page.hasMore,
    firstSeq: events[0]?.seq ?? null, lastSeq: events.at(-1)?.seq ?? null,
    nextBeforeSeq: events[0]?.seq ?? null,
    turn, calls, lastMessage, lastEvent,
  };
}

/**
 * One passive state read plus one bounded event page. Retains the native state
 * (queue/pending input included) and fixes the history window to its cursor.
 * No tree traversal, hidden pagination, polling or binding-cursor writes.
 */
export async function readExecution(client, target, { maxChars = 600, ...historyOptions } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('maxChars 必须为正整数。');
  const state = await readState(client, target);
  const throughSeq = historyOptions.throughSeq ?? state.cursor;
  // A native empty Session has cursor -1; there is no history to fetch.
  const page = throughSeq === -1
    ? { cursor: -1, hasMore: false, records: [] }
    : await readActivity(client, target, { maxMessages: 3, ...historyOptions, throughSeq });
  return { state, throughSeq, ...summarizeExecution(page, { maxChars }) };
}
