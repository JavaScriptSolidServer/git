import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import LightningFS from '@isomorphic-git/lightning-fs';
import { marked } from 'marked';

const html = htm.bind(h);

const fs = new LightningFS('jss-git', { wipe: true });
const dir = '/repo';

const MD_RE = /\.(md|markdown)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i;
const MAX_TEXT_BYTES = 512 * 1024; // 512KB cap

function isLikelyText(bytes) {
  // Treat as text if no NUL bytes in first 8KB
  const sample = bytes.slice(0, Math.min(bytes.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}

function App() {
  const params = new URLSearchParams(location.search);
  const initialUrl = params.get('repo') || '';
  const initialPath = params.get('path') || '';

  const [url, setUrl] = useState(initialUrl);
  const [path, setPath] = useState(initialPath);
  const [refs, setRefs] = useState(null);
  const [tree, setTree] = useState(null);
  const [readmeHtml, setReadmeHtml] = useState(null);
  const [fileView, setFileView] = useState(null); // { kind, content, path }
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [repoReady, setRepoReady] = useState(false);

  const loadFile = async (filePath) => {
    setError(null);
    setFileView(null);
    if (!filePath) return;
    try {
      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
      const { blob, oid } = await git.readBlob({ fs, dir, oid: headOid, filepath: filePath });

      if (IMAGE_RE.test(filePath)) {
        // Encode bytes to base64 for data URL
        let binary = '';
        for (let i = 0; i < blob.length; i++) binary += String.fromCharCode(blob[i]);
        const ext = filePath.split('.').pop().toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml'
                   : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                   : `image/${ext}`;
        setFileView({ kind: 'image', src: `data:${mime};base64,${btoa(binary)}`, path: filePath, oid });
        return;
      }

      if (blob.length > MAX_TEXT_BYTES) {
        setFileView({ kind: 'too-large', size: blob.length, path: filePath, oid });
        return;
      }

      if (!isLikelyText(blob)) {
        setFileView({ kind: 'binary', size: blob.length, path: filePath, oid });
        return;
      }

      const text = new TextDecoder().decode(blob);

      if (MD_RE.test(filePath)) {
        setFileView({ kind: 'markdown', html: marked.parse(text), path: filePath, oid });
      } else {
        setFileView({ kind: 'text', text, path: filePath, oid });
      }
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const loadRepo = async (repoUrl) => {
    if (!repoUrl) return;
    setLoading(true);
    setError(null);
    setRefs(null);
    setTree(null);
    setReadmeHtml(null);
    setFileView(null);
    setRepoReady(false);

    try {
      const refsResult = await git.listServerRefs({ http, url: repoUrl });
      setRefs(refsResult);

      if (refsResult.length === 0) {
        setLoading(false);
        return;
      }

      const headRef = refsResult.find(r => r.ref === 'HEAD');
      let branch = headRef?.target?.replace(/^refs\/heads\//, '');
      if (!branch) {
        const firstHead = refsResult.find(r => r.ref.startsWith('refs/heads/'));
        branch = firstHead?.ref.replace(/^refs\/heads\//, '');
      }
      if (!branch) {
        setLoading(false);
        return;
      }

      await git.clone({
        fs, http, dir,
        url: repoUrl,
        singleBranch: true,
        depth: 1,
        ref: branch,
      });

      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
      const { tree: treeEntries } = await git.readTree({ fs, dir, oid: headOid });
      treeEntries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
      setTree(treeEntries);

      const readmeEntry = treeEntries.find(
        e => e.type === 'blob' && /^README(\.md|\.markdown)?$/i.test(e.path)
      );
      if (readmeEntry) {
        const { blob } = await git.readBlob({ fs, dir, oid: readmeEntry.oid });
        const text = new TextDecoder().decode(blob);
        setReadmeHtml(marked.parse(text));
      }

      setRepoReady(true);

      // After repo loaded, if path is in URL, fetch that file
      if (path) await loadFile(path);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (initialUrl) loadRepo(initialUrl); }, []);

  const updateUrl = (newRepo, newPath) => {
    const p = new URLSearchParams();
    if (newRepo) p.set('repo', newRepo);
    if (newPath) p.set('path', newPath);
    history.pushState(null, '', `?${p}`);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const newUrl = e.target.elements.repo.value;
    setPath('');
    updateUrl(newUrl, '');
    loadRepo(newUrl);
  };

  const onFileClick = (e, filePath, type) => {
    if (type !== 'blob') return; // ignore folders for now
    e.preventDefault();
    setPath(filePath);
    updateUrl(url, filePath);
    if (repoReady) loadFile(filePath);
  };

  const onBackToRoot = (e) => {
    e.preventDefault();
    setPath('');
    setFileView(null);
    updateUrl(url, '');
  };

  // Browser back/forward sync
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(location.search).get('path') || '';
      setPath(p);
      if (p) loadFile(p); else setFileView(null);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [repoReady]);

  return html`
    <h1>JSS Git</h1>
    <p class="meta">Browse a git repository hosted on a Solid pod (or any git remote).</p>
    <form onSubmit=${onSubmit}>
      <div class="form-row">
        <input
          type="url"
          name="repo"
          placeholder="https://your.pod/path/repo"
          value=${url}
          onInput=${(e) => setUrl(e.target.value)}
        />
        <button type="submit">Load</button>
      </div>
    </form>

    ${error && html`<div class="error">${error}</div>`}
    ${loading && html`<p class="loading">Loading…</p>`}

    ${fileView && html`
      <p class="meta breadcrumb">
        <a href="#" onClick=${onBackToRoot}>← back to files</a>
        <span class="separator">/</span>
        <span class="path">${fileView.path}</span>
        <span class="oid">${fileView.oid?.slice(0, 8)}</span>
      </p>

      ${fileView.kind === 'markdown' && html`
        <div class="readme" dangerouslySetInnerHTML=${{ __html: fileView.html }}></div>
      `}
      ${fileView.kind === 'text' && html`
        <pre class="file-content"><code>${fileView.text}</code></pre>
      `}
      ${fileView.kind === 'image' && html`
        <div class="file-content image"><img src=${fileView.src} alt=${fileView.path} /></div>
      `}
      ${fileView.kind === 'binary' && html`
        <p class="meta">Binary file (${fileView.size} bytes) — preview not shown.</p>
      `}
      ${fileView.kind === 'too-large' && html`
        <p class="meta">File too large to display (${fileView.size} bytes).</p>
      `}
    `}

    ${!fileView && tree && tree.length > 0 && html`
      <h2>Files</h2>
      <ul class="file-list">
        ${tree.map((e) => html`
          <li>
            <span class="file-icon">${e.type === 'tree' ? '\u{1F4C1}' : '\u{1F4C4}'}</span>
            ${e.type === 'blob'
              ? html`<a href="?repo=${encodeURIComponent(url)}&path=${encodeURIComponent(e.path)}" onClick=${(ev) => onFileClick(ev, e.path, e.type)}>${e.path}</a>`
              : html`<span>${e.path}</span>`
            }
          </li>
        `)}
      </ul>
    `}

    ${!fileView && readmeHtml && html`
      <h2>README</h2>
      <div class="readme" dangerouslySetInnerHTML=${{ __html: readmeHtml }}></div>
    `}

    ${refs && refs.length > 0 && !fileView && html`
      <details style="margin-top: 1.5rem;">
        <summary>Refs (${refs.length})</summary>
        <ul class="ref-list">
          ${refs.map((r) => html`
            <li>
              <span>${r.ref}</span>
              <span class="oid">${r.oid?.slice(0, 8) || ''}</span>
            </li>
          `)}
        </ul>
      </details>
    `}

    ${refs && refs.length === 0 && html`<p class="meta">No refs found (empty repo).</p>`}

    <p class="meta" style="margin-top: 3rem;">
      Preact + HTM + isomorphic-git + marked. View source.
    </p>
  `;
}

render(html`<${App}/>`, document.getElementById('app'));
