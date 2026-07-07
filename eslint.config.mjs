import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  ...coreWebVitals,
  ...typescript,
  { ignores: [".next/**", "node_modules/**"] },
  {
    // lib/engine/** is ported verbatim from geo (which permits `any` for the
    // defensive SDK-response reads). Keeping the code byte-identical to the
    // source outweighs strictness here; everything else stays strict.
    files: ["lib/engine/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];

export default config;
