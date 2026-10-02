import * as mfm from "mfm-js";

const JAPANESE_CHAR = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}ー々]/u;

// MFM を AST にパース (mfm-js) して、学習に使う部分だけを取り出す。
// 地の文 (text)・Unicode 絵文字・日本語を含むハッシュタグ (の語幹) を残し、メンション・URL・リンク・カスタム絵文字・引用・コード・検索構文は捨てる。
// 英数字だけのハッシュタグ (#onsenfun など) は文に混ざると意味をなさないので捨てる。
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
        if (JAPANESE_CHAR.test(node.props.hashtag)) out.push(` ${node.props.hashtag} `);
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

// MFM の解析後に残る、文の材料にならない断片を消す。
// - mfm-js が URL と見なさないスキーム (wss:// など) の URL
// - 【お知らせ】のような見出し
// - 罫線文字
// - バージョン番号 (v0.4.1 / 2.48.1 など)
const stripNoise = (text: string) =>
  text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
    .replace(/【[^】\n]*】/g, " ")
    .replace(/[─-╿]/g, " ")
    .replace(/\bv?\d+(?:\.\d+){2,}\b/gi, " ");

export const cleanNoteText = (raw: string) =>
  stripNoise(extractText(mfm.parse(raw)))
    .replace(/[\t\r]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

const DELIMITERS = new Set(["。", "！", "？", "!", "?", "…", "‼", "⁉", "\n"]);
const CLOSERS = new Set(["」", "』", "）", ")", "〉", "《", "》", "］", "]"]);

// 文単位に分割する。終端記号と、その直後の閉じ括弧 (「…。」など) は直前の文に残す。
// 実質 (終端記号を除いた部分) が 1 文字の断片はノイズなので捨てる。
// 改行の直後に「…」が続くような場合でも、文の中に改行を残さない (トークナイザは 1 行を 1 文として扱うため)。
export const splitSentences = (text: string) => {
  const out: string[] = [];
  const push = (s: string) => {
    const trimmed = s.replace(/\n/g, "").trim();
    const content = trimmed.replace(/[。！？!?…‼⁉]+$/, "");
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

// コード・コマンド・ID の断片を含む文を見分ける。プログラムの記号や、数字と英字が混ざった長い 16 進列 (コミットハッシュや UUID) を目印にする。
const CODE_LIKE = /[=$|{}<>\\`;~^]|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])\b[0-9a-f]{7,}\b/i;

// 日本語の文として学習に向くかどうか。
// 英文やコード片のような文は、日本語の文と混ぜて学習すると文法の崩れた文を生む元になるので外す。
// 技術用語の英単語が混ざる文は残したいので、日本語の文字が文字全体の 3 割以上あればよしとする。
export const isJapaneseSentence = (sentence: string) => {
  if (CODE_LIKE.test(sentence)) return false;
  const letters = [...sentence].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (letters.length === 0) return false;
  const japanese = letters.filter((c) => JAPANESE_CHAR.test(c)).length;
  return japanese / letters.length >= 0.3;
};

// ノートやツイートの本文から、学習に使う文を取り出す。
export const extractLearningSentences = (raw: string) =>
  splitSentences(cleanNoteText(raw)).filter(isJapaneseSentence);
