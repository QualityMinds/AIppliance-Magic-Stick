import bsl from '../../../../LICENSE?raw';
import changeLicense from '../../../../licenses/MIT-CHANGE.txt?raw';
import overview from '../../../../LICENSING.md?raw';
import notices from '../../../../THIRD_PARTY_NOTICES.md?raw';
import npmNotices from '../../../../licenses/third-party/npm.txt?raw';
import pythonNotices from '../../../../licenses/third-party/python.txt?raw';
import {Panel} from './components';

const documents = [
  {title: 'Licensing overview', filename: 'LICENSING.md', text: overview},
  {title: 'Business Source License 1.1', filename: 'MagicStick-BSL.txt', text: bsl},
  {title: 'MIT Change License · after three years per version', filename: 'MIT-CHANGE.txt', text: changeLicense},
  {title: 'Third-party notices', filename: 'THIRD_PARTY_NOTICES.md', text: notices},
  {title: 'JavaScript dependency license texts', filename: 'npm-notices.txt', text: npmNotices},
  {title: 'Python dependency license texts', filename: 'python-notices.txt', text: pythonNotices},
];

export const SoftwareLicenses = () => <Panel title="Software licenses">
  <p>Magic Stick is source-available under BSL 1.1. Each version changes to MIT three years after its first public distribution. Third-party licenses remain separate.</p>
  <div className="stack compact">{documents.map((document) => <details key={document.filename} className="license-document">
    <summary>{document.title}</summary>
    <pre>{document.text}</pre>
    <a className="button button-ghost" href={`data:text/plain;charset=utf-8,${encodeURIComponent(document.text)}`} download={document.filename}>Download {document.title}</a>
  </details>)}</div>
</Panel>;
