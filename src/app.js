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

function App() {
  const initialUrl = new URLSearchParams(location.search).get('repo') || '';
  const [url, setUrl] = useState(initialUrl);
  const [refs, setRefs] = useState(null);
  const [tree, setTree] = useState(null);
  const [readmeHtml, setReadmeHtml] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadRepo = async (repoUrl) => {
    if (!repoUrl) return;
    setLoading(true);
    setError(null);
    setRefs(null);
    setTree(null);
    setReadmeHtml(null);

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
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (initialUrl) loadRepo(initialUrl); }, []);

  const onSubmit = (e) => {
    e.preventDefault();
    const newUrl = e.target.elements.repo.value;
    history.replaceState(null, '', `?${new URLSearchParams({ repo: newUrl })}`);
    loadRepo(newUrl);
  };

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

    ${tree && tree.length > 0 && html`
      <h2>Files</h2>
      <ul class="file-list">
        ${tree.map((e) => html`
          <li>
            <span class="file-icon">${e.type === 'tree' ? '\u{1F4C1}' : '\u{1F4C4}'}</span>
            <span>${e.path}</span>
          </li>
        `)}
      </ul>
    `}

    ${readmeHtml && html`
      <h2>README</h2>
      <div class="readme" dangerouslySetInnerHTML=${{ __html: readmeHtml }}></div>
    `}

    ${refs && refs.length > 0 && html`
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
