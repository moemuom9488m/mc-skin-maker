// src/page.html is the single source (Artifact form: no doctype/head/body).
// This wraps it into a full document for GitHub Pages and adds config.js.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/src/page.html', 'utf8').replace(/\r\n/g, '\n');
const cut = src.indexOf('</style>') + '</style>'.length;
const head = src.slice(0, cut).replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n/, '');
const body = src.slice(cut).replace(/^\n+/, '');
const out = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${head}
<script src="config.js"></script>
</head>
<body>
${body}</body>
</html>
`;
fs.writeFileSync(__dirname + '/docs/index.html', out);
console.log('docs/index.html', out.length, 'bytes');
