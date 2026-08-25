export type EditorKind =
  | 'native_input'
  | 'native_textarea'
  | 'generic_contenteditable'
  | 'lexical'
  | 'prosemirror'
  | 'tiptap'
  | 'draftjs'
  | 'quill'
  | 'slate'
  | 'unknown_managed';

export type TextWriteStrategy =
  | 'NATIVE_VALUE_SETTER'
  | 'REPLACE_SELECTION_BEFOREINPUT'
  | 'DOM_CONTENT_REPLACEMENT';

export type InputTrustLevel = 'DOM_SYNTHETIC' | 'KEYBOARD_TRANSPORT' | 'PRIVILEGED_BROWSER_INPUT';

export type TextWriteOutcome =
  | 'VERIFIED'
  | 'NO_EFFECT'
  | 'PARTIAL_EFFECT'
  | 'WRONG_VALUE'
  | 'EDITOR_REVERTED'
  | 'AMBIGUOUS';

export interface TextWriteEvidence {
  editorKind: EditorKind;
  strategy: TextWriteStrategy;
  trustLevel: InputTrustLevel;
  intendedHash: string;
  observedHash?: string;
  observedText?: string;
  outcome: TextWriteOutcome;
  detail?: string;
}

export function normalizeEditorText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export async function hashNormalizedText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeEditorText(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function detectEditorKind(editor: HTMLElement): EditorKind {
  if (editor instanceof HTMLTextAreaElement) return 'native_textarea';
  if (editor instanceof HTMLInputElement) return 'native_input';
  if (editor.matches('[data-lexical-editor="true"]')) return 'lexical';
  if (editor.matches('[data-slate-editor="true"]')) return 'slate';
  if (editor.matches('.public-DraftEditor-content, [data-block="true"]')) return 'draftjs';
  if (editor.matches('.ql-editor, .ql-container .ql-editor')) return 'quill';
  if (editor.matches('.tiptap, [data-tiptap-editor]')) return 'tiptap';
  if (editor.matches('.ProseMirror')) return 'prosemirror';
  if (editor.isContentEditable) return 'generic_contenteditable';
  return 'unknown_managed';
}

export function readEditorText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) return editor.value;
  return editor.innerText || editor.textContent || '';
}

export async function buildTextWriteEvidence(
  intendedText: string,
  observedText: string,
  editorKind: EditorKind,
  strategy: TextWriteStrategy,
): Promise<TextWriteEvidence> {
  const intendedHash = await hashNormalizedText(intendedText);
  const observedHash = await hashNormalizedText(observedText);
  const intended = normalizeEditorText(intendedText);
  const observed = normalizeEditorText(observedText);
  let outcome: TextWriteOutcome;
  if (observedHash === intendedHash) outcome = 'VERIFIED';
  else if (!observed) outcome = 'NO_EFFECT';
  else if (intended.includes(observed) || observed.includes(intended)) outcome = 'PARTIAL_EFFECT';
  else outcome = 'WRONG_VALUE';

  return {
    editorKind,
    strategy,
    trustLevel: 'DOM_SYNTHETIC',
    intendedHash,
    observedHash,
    observedText: observedText.slice(0, 2_000),
    outcome,
  };
}

export async function verifyStableTextWrite(
  intendedText: string,
  firstObservedText: string,
  secondObservedText: string,
  editorKind: EditorKind,
  strategy: TextWriteStrategy,
): Promise<TextWriteEvidence> {
  const first = await buildTextWriteEvidence(intendedText, firstObservedText, editorKind, strategy);
  const second = await buildTextWriteEvidence(intendedText, secondObservedText, editorKind, strategy);
  if (first.outcome === 'VERIFIED' && second.outcome !== 'VERIFIED') {
    return {
      ...second,
      outcome: 'EDITOR_REVERTED',
      detail: 'Composer matched the intended text immediately after write but changed before submit.',
    };
  }
  return second;
}
