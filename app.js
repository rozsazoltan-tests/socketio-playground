const { createDemoServer } = require("./server");

const { server, io } = createDemoServer();
const port = Number(process.env.PORT || 3000);

server.listen(port, () => {
  console.log(`Demo app listening on port ${port}`);
});

module.exports = { server, io };
