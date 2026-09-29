// Copied into the production installation and run in the target project:
// no source-checkout imports or mocked Pi extension API.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

const hostRequire = createRequire(import.meta.url);
const hostEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
const manifestPath = hostRequire.resolve('pi-messenger-swarm/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const peers = {};
for (const [name, range] of Object.entries(manifest.peerDependencies)) {
  const resolved = realpathSync(
    fileURLToPath(import.meta.resolve(name, pathToFileURL(manifestPath).href))
  );
  // The supported Pi packages expose dist/index.js as their entry point.
  const dependency = JSON.parse(readFileSync(path.resolve(resolved, '../../package.json'), 'utf8'));
  const hostResolved = realpathSync(fileURLToPath(import.meta.resolve(name, hostEntry)));
  const hostDependency = JSON.parse(
    readFileSync(path.resolve(hostResolved, '../../package.json'), 'utf8')
  );
  peers[name] = {
    version: dependency.version,
    range,
    resolved,
    hostResolved,
    hostVersion: hostDependency.version,
    suppliedByInstallation: resolved === realpathSync(fileURLToPath(import.meta.resolve(name))),
  };
}

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  additionalExtensionPaths: [path.dirname(manifestPath)],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const { extensions, errors } = loader.getExtensions();
console.log(
  JSON.stringify({
    peers,
    errors,
    extensions: extensions.map((extension) => ({
      path: extension.path,
      commands: [...extension.commands.keys()],
    })),
  })
);
