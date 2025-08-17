const express = require("express");
const app = express();

app.get("/", (_, res) => {
  res.send("Bot is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});
