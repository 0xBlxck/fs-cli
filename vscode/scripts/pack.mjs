// Fabrique fs-cli-vscode-<version>.vsix sans outil externe : un zip (format OPC) avec le manifeste VSIX.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const xml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// fichiers de l'extension (liste explicite : rien d'autre ne part dans le paquet)
const files = [['package.json'], ['extension.js'], ['README.md'], ['LICENSE', 'LICENSE.txt'],
  ...fs.readdirSync(path.join(root, 'media'), { withFileTypes: true }).filter(d => d.isFile()).map(d => [`media/${d.name}`])];

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description)}</Description>
    <Tags>${xml((pkg.keywords || []).join(','))}</Tags>
    <Categories>${xml((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xml(pkg.repository.url)}" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${xml(pkg.icon)}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xml(pkg.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;
const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${[['.json', 'application/json'], ['.js', 'application/javascript'], ['.md', 'text/markdown'], ['.txt', 'text/plain'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.css', 'text/css'], ['.vsixmanifest', 'text/xml']]
  .map(([e, t]) => `<Default Extension="${e}" ContentType="${t}" />`).join('\n')}
</Types>
`;

const entries = [
  ['extension.vsixmanifest', Buffer.from(manifest)],
  ['[Content_Types].xml', Buffer.from(types)],
  ...files.map(([src, dest]) => [`extension/${dest || src}`, fs.readFileSync(path.join(root, src))]),
];

// ── écriture du zip ──
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const parts = [], central = [];
let offset = 0;
const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
for (const [name, data] of entries) {
  const nameBuf = Buffer.from(name, 'utf8'), comp = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  parts.push(lh, nameBuf, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : root;   // dossier de sortie (FS-CLI : dossier temporaire)
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(out, Buffer.concat([...parts, cd, end]));
console.log(`✓ ${path.basename(out)} · ${entries.length} fichiers · ${(fs.statSync(out).size / 1024).toFixed(1)} Ko`);
