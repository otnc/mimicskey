import * as mfm from "mfm-js";

// MFM を AST にパース (mfm-js) して、学習に使う部分だけを取り出す。
// 地の文 (text)・Unicode 絵文字・ハッシュタグ (の語幹) を残し、メンション・URL・リンク・カスタム絵文字・引用・コード・検索構文は捨てる。
// fn ($[x2 ...] など) と装飾系のノードは中身を再帰的に取り出す。
// 改行は文の境界として使うので残す。
const extractText = (nodes: readonly mfm.MfmNode[]): string => {
  const out: string[] = [];
  const walk = (node: mfm.MfmNode): void => {
    switch (node.type) {
      case "text":
        out.push(node.props.text);
        return;
      case "hashtag":
        out.push(` ${node.props.hashtag} `);
        return;
      case "unicodeEmoji":
        out.push(node.props.emoji);
        return;
      case "fn":
      case "center":
      case "plain":
      case "bold":
      case "small":
      case "italic":
      case "strike":
        for (const child of node.children) walk(child);
        return;
      default:
        // mention / url / link / emojiCode / quote / search / blockCode / inlineCode / mathBlock / mathInline は捨てる
        return;
    }
  };
  for (const node of nodes) walk(node);
  return out.join("");
};

export const cleanNoteText = (raw: string) =>
  extractText(mfm.parse(raw))
    .replace(/[\t\r]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

const DELIMITERS = new Set(["。", "！", "？", "!", "?", "…", "‼", "⁉", "\n"]);
const CLOSERS = new Set(["」", "』", "）", ")", "〉", "《", "》", "］", "]"]);

// 文単位に分割する。終端記号と、その直後の閉じ括弧 (「…。」など) は直前の文に残す。
// 実質 (終端記号を除いた部分) が 1 文字の断片はノイズなので捨てる。
export const splitSentences = (text: string) => {
  const out: string[] = [];
  const push = (s: string) => {
    const trimmed = s.trim();
    const content = trimmed.replace(/[。！？!?…‼⁉\n]+$/, "");
    if (content.length >= 2) out.push(trimmed);
  };

  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (!DELIMITERS.has(text[i])) {
      i++;
      continue;
    }
    // 「！！」「……」のような連続した終端記号と閉じ括弧をまとめて吸収する。
    let j = i + 1;
    while (j < text.length && (DELIMITERS.has(text[j]) || CLOSERS.has(text[j]))) j++;
    push(text.slice(start, j));
    i = j;
    start = j;
  }
  push(text.slice(start));
  return out;
};
