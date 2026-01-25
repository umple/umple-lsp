const path = require("path");
const binding = require("node-gyp-build")(path.join(__dirname, "..", ".."));

try {
  module.exports = binding.language_umple();
} catch (e) {
  // For tree-sitter 0.21+
  module.exports = binding.tree_sitter_umple;
}
