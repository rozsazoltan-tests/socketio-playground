const { createDemoServer } = require("./server");

// server.js exports a factory so tests can create isolated instances.
// Passenger requires this entry, so startup must not depend on require.main.
const { server, io } = createDemoServer();
// Use the host-provided PORT, or 3000 for local runs without it.
const port = Number(process.env.PORT || 3000);

server.listen(port, () => {
  console.log(`Demo app listening on port ${port}`);
});

module.exports = { server, io };
