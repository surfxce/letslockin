import Foundation

public func buildReaderDocumentHTML(
    bodyHTML: String,
    termsJSON: String,
    savedScroll: Double
) -> String {
    let safeTerms = termsJSON.replacingOccurrences(of: "<", with: "\\u003c")
    return """
    <!doctype html>
    <html>
    <head>
    <meta charset="utf-8">
    <style>
      :root {
        color-scheme: light dark;
        --fg: #1d1d1f;
        --muted: #6e6e73;
        --border: rgba(128,128,128,0.22);
        --card-bg: rgba(128,128,128,0.06);
        --accent: #5856d6;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --fg: #f5f5f7;
          --muted: #98989d;
          --border: rgba(255,255,255,0.16);
          --card-bg: rgba(255,255,255,0.06);
          --accent: #7d7aff;
        }
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        font-size: 15px;
        line-height: 1.62;
        color: var(--fg);
        margin: 0;
        padding: 4px 2px 48px 2px;
        background: transparent;
      }
      h1, h2, h3, h4 {
        font-weight: 650;
        line-height: 1.3;
        margin-top: 1.35em;
        margin-bottom: 0.45em;
      }
      table { border-collapse: collapse; width: 100%; }
      td, th { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
      h2 { font-size: 1.28em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
      h3 { font-size: 1.1em; }
      p, ul, ol { margin-top: 0.45em; margin-bottom: 0.65em; }
      ul, ol { padding-left: 1.45em; }
      li { margin: 0.24em 0; }
      ul ul { list-style-type: circle; }
      ul ul ul { list-style-type: square; }
      code {
        font-family: "SF Mono", ui-monospace, Menlo, monospace;
        font-size: 0.9em;
        background: var(--card-bg);
        padding: 1px 5px;
        border-radius: 4px;
      }
      pre {
        background: var(--card-bg);
        padding: 10px 12px;
        border-radius: 8px;
        overflow-x: auto;
      }
      figure.slide-fig {
        margin: 14px 0;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--card-bg);
      }
      .slide-shot {
        position: relative;
        display: inline-block;
        max-width: 100%;
      }
      .slide-fig.multi {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .slide-fig.multi .slide-shot {
        flex: 1 1 280px;
      }
      figure.slide-fig img {
        display: block;
        max-width: 100%;
        height: auto;
        border-radius: 6px;
      }
      button.slide-crop {
        position: absolute;
        top: 8px;
        right: 8px;
        font-size: 12px;
        font-weight: 500;
        padding: 4px 9px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: rgba(20, 20, 22, 0.75);
        color: #fff;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .slide-shot:hover button.slide-crop {
        opacity: 1;
      }
      figure.slide-fig figcaption {
        margin-top: 6px;
        font-size: 12.5px;
        color: var(--muted);
      }
      .slide-tag {
        font-weight: 600;
        color: var(--fg);
      }
      mark.glossary-term {
        background: transparent;
        color: inherit;
        border-bottom: 2px dotted var(--accent);
        cursor: pointer;
        padding-bottom: 1px;
      }
      mark.glossary-term:hover {
        background: rgba(88, 86, 214, 0.14);
      }
    </style>
    </head>
    <body>
    <div id="summary-root">\(bodyHTML)</div>
    <script>
      const TERMS = \(safeTerms);
      const SAVED_SCROLL = \(savedScroll);

      function post(msg) {
        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lockinReader) {
          window.webkit.messageHandlers.lockinReader.postMessage(msg);
        }
      }

      // Highlight glossary terms across text nodes
      function highlightTerms() {
        if (!TERMS || !TERMS.length) return;
        const root = document.getElementById('summary-root');
        if (!root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (!n.parentElement) continue;
          if (n.parentElement.closest('code, pre, figcaption, button, mark')) continue;
          textNodes.push(n);
        }
        const sorted = [...TERMS].sort((a, b) => b.term.length - a.term.length);
        for (const node of textNodes) {
          let remaining = node.nodeValue || '';
          const fragment = document.createDocumentFragment();
          while (remaining) {
            let best = null;
            for (const entry of sorted) {
              if (!entry.term) continue;
              const escaped = entry.term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
              const re = new RegExp('(?<![\\p{L}\\p{N}])(' + escaped + ')(?![\\p{L}\\p{N}])', 'iu');
              const match = re.exec(remaining);
              if (match && (!best || match.index < best.match.index)) best = { entry, match };
            }
            if (!best) { fragment.append(document.createTextNode(remaining)); break; }
            fragment.append(document.createTextNode(remaining.slice(0, best.match.index)));
            const mark = document.createElement('mark');
            mark.className = 'glossary-term';
            mark.dataset.termId = best.entry.id;
            mark.textContent = best.match[1];
            fragment.append(mark);
            remaining = remaining.slice(best.match.index + best.match[1].length);
          }
          node.replaceWith(fragment);
        }
      }

      highlightTerms();

      document.addEventListener('selectionchange', () => {
        const sel = window.getSelection();
        const text = sel ? sel.toString() : '';
        post({ type: 'selection', text });
      });

      document.addEventListener('click', (e) => {
        const cropBtn = e.target.closest('button.slide-crop');
        if (cropBtn) {
          e.preventDefault();
          e.stopPropagation();
          const figure = parseInt(cropBtn.getAttribute('data-fig') || '0', 10);
          const slide = parseInt(cropBtn.getAttribute('data-slide') || '1', 10);
          const crop = cropBtn.getAttribute('data-crop') || null;
          post({ type: 'crop', figure, slide, crop });
          return;
        }
        const mark = e.target.closest('mark.glossary-term');
        if (mark) {
          e.preventDefault();
          post({ type: 'term', id: mark.dataset.termId });
        }
      });

      document.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, a, mark, figure')) return;
        post({ type: 'dblclickEdit' });
      });

      window.addEventListener('scroll', () => {
        post({ type: 'scroll', y: window.scrollY });
      }, { passive: true });

      if (SAVED_SCROLL > 0) {
        setTimeout(() => window.scrollTo(0, SAVED_SCROLL), 30);
      }
    </script>
    </body>
    </html>
    """
}

public func buildEditorDocumentHTML(bodyHTML: String) -> String {
    return """
    <!doctype html>
    <html>
    <head>
    <meta charset="utf-8">
    <style>
      :root {
        color-scheme: light dark;
        --fg: #1d1d1f;
        --muted: #6e6e73;
        --border: rgba(128,128,128,0.25);
        --card-bg: rgba(128,128,128,0.06);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --fg: #f5f5f7;
          --muted: #98989d;
          --border: rgba(255,255,255,0.18);
          --card-bg: rgba(255,255,255,0.06);
        }
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        font-size: 15px;
        line-height: 1.62;
        color: var(--fg);
        margin: 0;
        padding: 10px;
        background: transparent;
      }
      #editor {
        outline: none;
        min-height: 440px;
      }
      table { border-collapse: collapse; width: 100%; }
      td, th { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
      h2 { font-size: 1.28em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
      h3 { font-size: 1.1em; }
      ul, ol { padding-left: 1.45em; }
      ul ul { list-style-type: circle; }
      ul ul ul { list-style-type: square; }
      figure.slide-fig {
        margin: 12px 0;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--card-bg);
      }
      figure.slide-fig img {
        max-width: 100%;
        height: auto;
        border-radius: 6px;
      }
    </style>
    </head>
    <body>
    <div id="editor" contenteditable="true">\(bodyHTML)</div>
    <script>
      function post(msg) {
        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lockinEditor) {
          window.webkit.messageHandlers.lockinEditor.postMessage(msg);
        }
      }

      const editor = document.getElementById('editor');
      for (const fig of editor.querySelectorAll('figure.slide-fig')) {
        fig.setAttribute('contenteditable', 'false');
      }

      let savedRange = null;
      document.addEventListener('selectionchange', () => {
        const selection = window.getSelection();
        if (selection.rangeCount && editor.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
      });
      window.setLineKind = kind => {
        editor.focus();
        if (savedRange) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(savedRange); }
        if (kind.startsWith('bullet')) {
          let node = window.getSelection().anchorNode;
          let element = node && (node.nodeType === 1 ? node : node.parentElement);
          if (!element || !element.closest('li')) document.execCommand('insertUnorderedList');
          for (let i = 0; i < 3; i++) document.execCommand('outdent');
          for (let i = 1; i < Number(kind.slice(-1)); i++) document.execCommand('indent');
        } else { document.execCommand('formatBlock', false, kind === 'text' ? 'p' : kind); }
        post({ type: 'change', markdown: serializeEditor() });
      };

      function inlineToMd(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') return '\\n';
        const inner = Array.from(node.childNodes).map(inlineToMd).join('');
        if (tag === 'strong' || tag === 'b') return '**' + inner + '**';
        if (tag === 'em' || tag === 'i') return '*' + inner + '*';
        if (tag === 'code') return '`' + inner + '`';
        if (tag === 'img') return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
        if (tag === 'a') return '[' + inner + '](' + (node.getAttribute('href') || '') + ')';
        return inner;
      }

      function listToMd(listEl, indent) {
        const lines = [];
        const ordered = listEl.tagName.toLowerCase() === 'ol';
        let idx = 1;
        for (const li of Array.from(listEl.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          let textParts = [];
          let childLists = [];
          for (const child of Array.from(li.childNodes)) {
            if (child.nodeType === Node.ELEMENT_NODE && (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')) {
              childLists.push(child);
            } else {
              textParts.push(inlineToMd(child));
            }
          }
          const prefix = ' '.repeat(indent) + (ordered ? (idx++ + '. ') : '- ');
          lines.push(prefix + textParts.join('').trim());
          for (const sub of childLists) {
            lines.push(listToMd(sub, indent + 2));
          }
        }
        return lines.join('\\n');
      }

      function serializeEditor() {
        const blocks = [];
        for (const child of Array.from(editor.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            const t = (child.nodeValue || '').trim();
            if (t) blocks.push(t);
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) continue;
          const tag = child.tagName.toLowerCase();
          if (tag === 'h1') blocks.push('# ' + inlineToMd(child).trim());
          else if (tag === 'h2') blocks.push('## ' + inlineToMd(child).trim());
          else if (tag === 'h3') blocks.push('### ' + inlineToMd(child).trim());
          else if (/^h[4-6]$/.test(tag)) blocks.push('#'.repeat(Number(tag[1])) + ' ' + inlineToMd(child).trim());
          else if (tag === 'blockquote') blocks.push(inlineToMd(child).trim().split('\\n').map(line => '> ' + line).join('\\n'));
          else if (tag === 'hr') blocks.push('---');
          else if (tag === 'ul' || tag === 'ol') blocks.push(listToMd(child, 0));
          else if (tag === 'pre') {
            const code = child.querySelector('code');
            const language = code ? (code.className.match(/language-([^ ]+)/) || [,''])[1] : '';
            blocks.push('```' + language + '\\n' + (child.textContent || '').replace(/\\n$/, '') + '\\n```');
          }
          else if (tag === 'table') {
            const rows = Array.from(child.querySelectorAll('tr'));
            if (rows.length) {
              const row = tr => '| ' + Array.from(tr.children).map(cell => inlineToMd(cell).trim()).join(' | ') + ' |';
              const divider = '| ' + Array.from(rows[0].children).map(cell => cell.style.textAlign === 'center' ? ':---:' : cell.style.textAlign === 'right' ? '---:' : '---').join(' | ') + ' |';
              blocks.push([row(rows[0]), divider, ...rows.slice(1).map(row)].join('\\n'));
            }
          }
          else if (tag === 'figure') {
            const source = child.getAttribute('data-slide-source');
            const caption = child.getAttribute('data-slide-caption') || '';
            if (source) blocks.push('![' + caption + '](' + source + ')');
          } else {
            const t = inlineToMd(child).trim();
            if (t) blocks.push(t);
          }
        }
        return blocks.join('\\n\\n') + '\\n';
      }

      editor.addEventListener('input', () => {
        post({ type: 'change', markdown: serializeEditor() });
      });

      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          post({ type: 'save' });
        } else if (e.key === 'Escape') {
          e.preventDefault();
          post({ type: 'cancel' });
        } else if (e.key === 'Tab') {
          e.preventDefault();
          document.execCommand(e.shiftKey ? 'outdent' : 'indent');
          post({ type: 'change', markdown: serializeEditor() });
        }
      });
    </script>
    </body>
    </html>
    """
}
