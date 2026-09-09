;(function installMoodNotesCopyRange(global) {
  'use strict';

  if (global.TaskPointsMoodNotesCopyRange?.installed) return;

  const STORAGE_KEY = 'taskpoints_v1';
  const DEFAULT_RANGE_DAYS = 7;

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function localDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function formatCompactDate(date) {
    return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(-2)}`;
  }

  function formatRangeDate(dateKey) {
    const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return dateKey || '';
    return `${Number(match[2])}/${Number(match[3])}/${String(match[1]).slice(-2)}`;
  }

  function getStoredState() {
    try {
      if (global.TaskPointsCore?.loadAppState) {
        return global.TaskPointsCore.loadAppState({ syncDerived: false, persistSync: false }).state || {};
      }
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return {};
      if (global.TaskPointsCore?.readTaskPointsStoredState) {
        return global.TaskPointsCore.readTaskPointsStoredState(STORAGE_KEY, {}) || {};
      }
      return JSON.parse(raw);
    } catch (error) {
      console.warn('Failed to load Mood Notes for clipboard copy', error);
      return {};
    }
  }

  function getMoodNoteEntries(state = getStoredState()) {
    const completions = Array.isArray(state?.completions) ? state.completions : [];
    return completions
      .filter((entry) => entry && typeof entry === 'object')
      .filter((entry) => typeof entry.title === 'string' && entry.title.startsWith('Mood Score'))
      .map((entry) => {
        const note = typeof entry.moodNotes === 'string' ? entry.moodNotes.trim() : '';
        const completedDate = new Date(entry.completedAtISO);
        return {
          note,
          completedDate,
          completedAtISO: entry.completedAtISO,
          dateKey: localDateKey(completedDate)
        };
      })
      .filter((entry) => entry.note && entry.dateKey)
      .sort((a, b) => b.completedDate.getTime() - a.completedDate.getTime());
  }

  function buildGroupedMoodNotesText(entries) {
    const lines = [];
    let currentDateKey = '';
    entries.forEach((entry) => {
      if (entry.dateKey !== currentDateKey) {
        if (lines.length) lines.push('');
        lines.push(formatCompactDate(entry.completedDate));
        currentDateKey = entry.dateKey;
      }
      lines.push(`- ${entry.note}`);
    });
    return lines.join('\n');
  }

  function buildRangeCopy(startKey, endKey, state = getStoredState()) {
    const start = String(startKey || '');
    const end = String(endKey || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { ok: false, reason: 'Choose a start and end date.', text: '', count: 0 };
    }
    if (start > end) {
      return { ok: false, reason: 'Start date must be on or before end date.', text: '', count: 0 };
    }

    const entries = getMoodNoteEntries(state).filter((entry) => entry.dateKey >= start && entry.dateKey <= end);
    if (!entries.length) {
      return { ok: false, reason: 'No mood notes in that date range.', text: '', count: 0 };
    }

    const heading = `Mood Notes — ${formatRangeDate(start)} to ${formatRangeDate(end)}`;
    return {
      ok: true,
      reason: '',
      count: entries.length,
      text: `${heading}\n\n${buildGroupedMoodNotesText(entries)}`
    };
  }

  async function writeClipboardText(text) {
    if (global.navigator?.clipboard?.writeText) {
      try {
        await global.navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }

    const doc = global.document;
    if (!doc?.body || typeof doc.execCommand !== 'function') return false;
    const textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    doc.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try { copied = doc.execCommand('copy'); } catch (_) {}
    textarea.remove();
    return copied;
  }

  function createDateInput(id, labelText) {
    const label = global.document.createElement('label');
    label.className = 'mood-copy-date-field';
    label.setAttribute('for', id);
    label.textContent = labelText;
    const input = global.document.createElement('input');
    input.id = id;
    input.type = 'date';
    input.className = 'input';
    label.appendChild(input);
    return { label, input };
  }

  function installStyles() {
    if (global.document.getElementById('moodNotesCopyRangeStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'moodNotesCopyRangeStyles';
    style.textContent = `
      .mood-notes-copy-range{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.55rem;margin-bottom:.75rem;padding:.7rem;border:1px solid rgba(148,163,184,.2);border-radius:12px;background:rgba(15,23,42,.18)}
      .mood-copy-date-field{display:flex;flex-direction:column;gap:.25rem;font-size:.75rem;color:var(--muted,#94a3b8);min-width:9rem;flex:0 1 10rem}
      .mood-copy-date-field .input{width:100%;min-height:2.45rem}
      .mood-notes-copy-range .mood-copy-button{min-height:2.45rem}
      .mood-copy-status{font-size:.75rem;min-height:1.1rem;flex:1 1 100%;color:var(--muted,#94a3b8)}
      @media (max-width:640px){.mood-copy-date-field{flex:1 1 calc(50% - .3rem);min-width:0}.mood-notes-copy-range .mood-copy-button{flex:1 1 100%}}
    `;
    global.document.head?.appendChild(style);
  }

  function installUi() {
    const panel = global.document?.getElementById('moodNotesPanel');
    const list = global.document?.getElementById('moodNotesList');
    if (!panel || !list || global.document.getElementById('moodNotesCopyRange')) return false;

    installStyles();
    const controls = global.document.createElement('div');
    controls.id = 'moodNotesCopyRange';
    controls.className = 'mood-notes-copy-range';
    controls.setAttribute('aria-label', 'Copy Mood Notes by date range');

    const from = createDateInput('moodNotesCopyFrom', 'From');
    const to = createDateInput('moodNotesCopyTo', 'To');
    const button = global.document.createElement('button');
    button.id = 'moodNotesCopyButton';
    button.type = 'button';
    button.className = 'btn btn-teal btn-toolbar mood-copy-button';
    button.textContent = 'Copy Range';
    const status = global.document.createElement('div');
    status.id = 'moodNotesCopyStatus';
    status.className = 'mood-copy-status';
    status.setAttribute('aria-live', 'polite');

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - (DEFAULT_RANGE_DAYS - 1));
    from.input.value = localDateKey(start);
    to.input.value = localDateKey(today);

    controls.append(from.label, to.label, button, status);
    list.parentNode.insertBefore(controls, list);

    button.addEventListener('click', async () => {
      const result = buildRangeCopy(from.input.value, to.input.value);
      if (!result.ok) {
        status.textContent = result.reason;
        return;
      }

      button.disabled = true;
      const originalText = button.textContent;
      const copied = await writeClipboardText(result.text);
      button.disabled = false;
      if (!copied) {
        status.textContent = 'Could not copy automatically. Try again from a secure browser window.';
        return;
      }

      button.textContent = 'Copied!';
      status.textContent = `Copied ${result.count} mood note${result.count === 1 ? '' : 's'}.`;
      global.setTimeout?.(() => { button.textContent = originalText; }, 1400);
    });

    return true;
  }

  function boot() {
    if (installUi()) return;
    if (global.document?.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', installUi, { once: true });
    }
  }

  const api = {
    installed: true,
    localDateKey,
    getMoodNoteEntries,
    buildGroupedMoodNotesText,
    buildRangeCopy,
    writeClipboardText,
    installUi
  };
  global.TaskPointsMoodNotesCopyRange = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  boot();
})(typeof window !== 'undefined' ? window : globalThis);
