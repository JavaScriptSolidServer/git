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
const MAX_TEXT_BYTES = 512 * 1024;
const HISTORY_DEPTH = 50;

function isLikelyText(bytes) {
  const sample = bytes.slice(0, Math.min(bytes.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}

function relativeTime(seconds) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

function parseRepoUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    let owner = u.hostname;
    let repo = parts[parts.length - 1] || u.hostname;

    const gitIndex = parts.indexOf('git');
    if (gitIndex >= 0 && parts[gitIndex - 1] && parts[gitIndex + 1]) {
      owner = parts[gitIndex - 1];
      repo = parts[gitIndex + 1];
    }
    repo = repo.replace(/\.git$/, '');
    return { owner, repo };
  } catch {
    return { owner: '', repo: rawUrl };
  }
}

function App() {
  const params = new URLSearchParams(location.search);
  const initialUrl = params.get('repo') || '';
  const initialPath = params.get('path') || '';
  const initialView = params.get('view') || 'files';

  const [url, setUrl] = useState(initialUrl);
  const [path, setPath] = useState(initialPath);
  const [view, setView] = useState(initialView);
  const [refs, setRefs] = useState(null);
  const [tree, setTree] = useState(null);
  const [readmeHtml, setReadmeHtml] = useState(null);
  const [fileView, setFileView] = useState(null);
  const [commits, setCommits] = useState(null);
  const [historyFetched, setHistoryFetched] = useState(false);
  const [latestCommit, setLatestCommit] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [repoReady, setRepoReady] = useState(false);
  const [branch, setBranch] = useState(null);

  const loadFile = async (filePath) => {
    setError(null);
    setFileView(null);
    if (!filePath) return;
    try {
      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
      const { blob, oid } = await git.readBlob({ fs, dir, oid: headOid, filepath: filePath });

      if (IMAGE_RE.test(filePath)) {
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

  const loadCommits = async () => {
    if (commitsLoading) return;
    setCommitsLoading(true);
    setError(null);
    try {
      if (!historyFetched && branch) {
        await git.fetch({
          fs, http, dir,
          singleBranch: true,
          depth: HISTORY_DEPTH,
          ref: branch,
        });
        setHistoryFetched(true);
      }
      const log = await git.log({ fs, dir, depth: HISTORY_DEPTH });
      setCommits(log);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setCommitsLoading(false);
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
    setCommits(null);
    setHistoryFetched(false);
    setLatestCommit(null);
    setRepoReady(false);

    try {
      const refsResult = await git.listServerRefs({ http, url: repoUrl });
      setRefs(refsResult);

      if (refsResult.length === 0) {
        setLoading(false);
        return;
      }

      const headRef = refsResult.find(r => r.ref === 'HEAD');
      let resolvedBranch = headRef?.target?.replace(/^refs\/heads\//, '');
      if (!resolvedBranch) {
        const firstHead = refsResult.find(r => r.ref.startsWith('refs/heads/'));
        resolvedBranch = firstHead?.ref.replace(/^refs\/heads\//, '');
      }
      if (!resolvedBranch) {
        setLoading(false);
        return;
      }
      setBranch(resolvedBranch);

      await git.clone({
        fs, http, dir,
        url: repoUrl,
        singleBranch: true,
        depth: 1,
        ref: resolvedBranch,
      });

      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });

      const headCommit = await git.readCommit({ fs, dir, oid: headOid });
      setLatestCommit({
        oid: headOid,
        author: headCommit.commit.author.name,
        message: headCommit.commit.message.split('\n')[0],
        timestamp: headCommit.commit.author.timestamp,
      });

      const { tree: treeEntries } = await git.readTree({ fs, dir, oid: headCommit.commit.tree });
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

      if (path) await loadFile(path);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (initialUrl) loadRepo(initialUrl); }, []);

  // When view switches to commits and repo is ready, lazy-load commits
  useEffect(() => {
    if (view === 'commits' && repoReady && !commits && !commitsLoading) {
      loadCommits();
    }
  }, [view, repoReady]);

  const updateUrl = (next) => {
    const p = new URLSearchParams();
    if (next.repo) p.set('repo', next.repo);
    if (next.path) p.set('path', next.path);
    if (next.view && next.view !== 'files') p.set('view', next.view);
    history.pushState(null, '', `?${p}`);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const newUrl = e.target.elements.repo.value;
    setPath('');
    setView('files');
    updateUrl({ repo: newUrl });
    loadRepo(newUrl);
  };

  const onFileClick = (e, filePath, type) => {
    if (type !== 'blob') return;
    e.preventDefault();
    setPath(filePath);
    updateUrl({ repo: url, path: filePath });
    if (repoReady) loadFile(filePath);
  };

  const switchView = (e, newView) => {
    e.preventDefault();
    setPath('');
    setFileView(null);
    setView(newView);
    updateUrl({ repo: url, view: newView });
  };

  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(location.search);
      const newPath = p.get('path') || '';
      const newView = p.get('view') || 'files';
      setPath(newPath);
      setView(newView);
      if (newPath) loadFile(newPath); else setFileView(null);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [repoReady]);

  const showRoot = !fileView;
  const showFiles = showRoot && view === 'files';
  const showCommits = showRoot && view === 'commits';

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

    ${repoReady && (() => {
      const { owner, repo } = parseRepoUrl(url);
      return html`
        <div class="repo-header">
          <span class="repo-breadcrumb">
            <span class="owner">${owner}</span>
            <span class="separator">/</span>
            <strong class="repo-name">${repo}</strong>
          </span>
        </div>
      `;
    })()}

    ${repoReady && !fileView && html`
      <div class="tabs">
        <a href="#" class=${view === 'files' ? 'tab active' : 'tab'} onClick=${(e) => switchView(e, 'files')}>Code</a>
        <a href="#" class=${view === 'commits' ? 'tab active' : 'tab'} onClick=${(e) => switchView(e, 'commits')}>Commits${commits ? ` (${commits.length})` : ''}</a>
      </div>
    `}

    ${showFiles && latestCommit && html`
      <div class="latest-commit">
        <span class="commit-author">${latestCommit.author}</span>
        <span class="commit-msg">${latestCommit.message}</span>
        <span class="oid">${latestCommit.oid.slice(0, 8)}</span>
        <span class="meta">${relativeTime(latestCommit.timestamp)}</span>
      </div>
    `}

    ${fileView && html`
      <p class="meta breadcrumb">
        <a href="#" onClick=${(e) => switchView(e, 'files')}>← back to files</a>
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

    ${showFiles && tree && tree.length > 0 && html`
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

    ${showFiles && readmeHtml && html`
      <h2>README</h2>
      <div class="readme" dangerouslySetInnerHTML=${{ __html: readmeHtml }}></div>
    `}

    ${showCommits && commitsLoading && html`<p class="loading">Loading commits…</p>`}

    ${showCommits && commits && commits.length > 0 && html`
      <ul class="commit-list">
        ${commits.map((c) => html`
          <li class="commit">
            <div class="commit-message">${c.commit.message.split('\n')[0]}</div>
            <div class="commit-meta">
              <span class="commit-author">${c.commit.author.name}</span>
              <span>committed ${relativeTime(c.commit.author.timestamp)}</span>
              <span class="oid">${c.oid.slice(0, 8)}</span>
            </div>
          </li>
        `)}
      </ul>
    `}

    ${showCommits && commits && commits.length === 0 && html`<p class="meta">No commits.</p>`}

    ${refs && refs.length > 0 && !fileView && view === 'files' && html`
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
