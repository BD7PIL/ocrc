/**
 * stylelint —— A1 令牌约束门禁（best-of 裁决 2026-10-12，批次 1）
 *
 * 规则：组件层样式一律消费 theme.css 的语义 token，**禁写裸 hex**
 * （`color-no-hex` 对声明值全域生效，含简写/自定义属性）。
 * 豁免：src/styles/theme.css 是 token 定义层本体（LAYER 0/1/2 的原料值）；
 *       src/styles/persimmon-theme.css 是封存的回肤色板（不参与构建）；
 *       src/styles/skin-openbitfun.css 是 OpenBitFun 候选皮肤（未接入，
 *       token 定义层本体，见 docs/research/openbitfun-skin-mapping.md）；
 *       src/zcode/zcode-theme-bridge.css 是 vendor --color-* 桥（ink 字面值，
 *       搬运自已验收样张；var() 化重构留批 3）。
 * vendor 不在扫描范围（`npm run lint` 只跑 src/**\/*.css）。
 */
export default {
  rules: {
    'color-no-hex': true,
  },
  overrides: [
    {
      files: [
        'src/styles/theme.css',
        'src/styles/persimmon-theme.css',
        'src/styles/skin-openbitfun.css',
        'src/zcode/zcode-theme-bridge.css',
      ],
      rules: {
        'color-no-hex': null,
      },
    },
  ],
}
