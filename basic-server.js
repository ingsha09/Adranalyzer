
const http = require('http');
const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end("Hello from your Node.js backend! I'm alive!\n");
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Basic server running at http://0.0.0.0:${port}/`);
});
