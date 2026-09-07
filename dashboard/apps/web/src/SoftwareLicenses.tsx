import mit from '../../../../LICENSE?raw';
import enterprise from '../../../../enterprise/LICENSE?raw';
import overview from '../../../../LICENSING.md?raw';
import {Panel} from './components';

const documents = [
  {title: 'Licensing overview', filename: 'LICENSING.md', text: overview},
  {title: 'Community · MIT License', filename: 'MagicStick-MIT.txt', text: mit},
  {title: 'Enterprise · Provisional notice', filename: 'MagicStick-Enterprise.txt', text: enterprise},
];

export const SoftwareLicenses = () => <Panel title="Software licenses">
  <p>Community is MIT-licensed, including commercial use. Only explicitly marked Enterprise code has separate terms. Existing MIT rights are unchanged.</p>
  <p className="muted">A signed entitlement file is a technical activation record, not a commercial agreement. The Enterprise notice is provisional and subject to review.</p>
  <div className="stack compact">{documents.map((document) => <details key={document.filename} className="license-document">
    <summary>{document.title}</summary>
    <pre>{document.text}</pre>
    <a className="button button-ghost" href={`data:text/plain;charset=utf-8,${encodeURIComponent(document.text)}`} download={document.filename}>Download {document.title}</a>
  </details>)}</div>
</Panel>;
