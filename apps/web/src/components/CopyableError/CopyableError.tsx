import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';

/**
 * An error message in the red box the status panels use, with a button that
 * copies it verbatim. wacli errors are long, carry key ids and versions, and
 * are what an operator pastes into an issue or a search, so retyping them from
 * a narrow panel is not a fair ask.
 */
export const CopyableError: React.FC<{ message: string; className?: string }> = ({ message, className = '' }) => {
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      return;
    } catch {
      // No clipboard permission, or no Clipboard API at all on a plain-http
      // origin such as a LAN address. Fall through to the selection.
    }
    // Select the text so the button still leaves it one keystroke from the
    // clipboard, and let the old copy command take it if the browser allows.
    const node = textRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    if (typeof document.execCommand === 'function' && document.execCommand('copy')) setCopied(true);
  };

  return (
    <div
      className={`bg-mc-danger/10 border border-mc-danger/30 p-2 rounded text-[11px] text-mc-danger flex items-start gap-1.5 ${className}`}
    >
      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
      <span ref={textRef} className="break-all select-text flex-1 min-w-0">{message}</span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        title="Copy error message"
        aria-label={copied ? 'Error message copied' : 'Copy error message'}
        className="shrink-0 p-0.5 rounded text-mc-danger/80 hover:text-mc-danger hover:bg-mc-danger/10 transition-colors"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
};
