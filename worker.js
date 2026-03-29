/**
 * ft-automation: 遺跡解析ツール v3.1
 * BYOK対応・マルチモデル・多言語・Stripe決済・Resendメール
 */
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Gemini-Key, X-Anthropic-Key, X-OpenAI-Key",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // ── Stripe Webhook エンドポイント ──
    if (url.pathname === "/webhook/stripe") {
      return handleStripeWebhook(request, env);
    }

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // ── 1. 購入者キー検証 ──
    const apiKey = request.headers.get("X-API-Key") || "";
    if (!apiKey) return json({ error: "APIキーが必要です" }, 401, cors);
    const keyData = await env.LEGACY_KEYS.get(apiKey);
    if (!keyData) return json({ error: "無効なAPIキーです。購入後に発行されたキーをご確認ください" }, 403, cors);
    const { active } = JSON.parse(keyData);
    if (!active) return json({ error: "このAPIキーは無効化されています" }, 403, cors);

    // ── 2. リクエスト取得 ──
    let body;
    try { body = await request.json(); } catch { return json({ error: "リクエスト形式エラー" }, 400, cors); }
    const { code, lang = "Unknown", targetLang = "TypeScript", mode = "code", model = "gemini-2.5-flash", provider = "gemini", outputLang = "ja" } = body;
    if (!code?.trim()) return json({ error: "コードを入力してください" }, 400, cors);

    const geminiKey    = request.headers.get("X-Gemini-Key")    || env.GEMINI_API_KEY;
    const anthropicKey = request.headers.get("X-Anthropic-Key") || env.ANTHROPIC_API_KEY;

    // ── 3. プロンプト生成 ──
    const langNames = { ja:"日本語", en:"English", zh:"中文", ko:"한국어", hi:"हिंदी", ne:"नेपाली" };
    const outLangName = langNames[outputLang] || "日本語";

    const codePrompt = `あなたはレガシーコード変換の専門家です。
以下の${lang}コードを${targetLang}に変換してください。

【入力コード】
${code}

【出力要件】
1. 変換後の完全な${targetLang}コード（コードブロック付き）
2. 主要な変更点の説明（3〜5点）
3. 注意事項・互換性の問題

回答は${outLangName}で記述してください。`;

    const reportPrompt = `あなたはレガシーシステム移行の専門コンサルタントです。
以下の${lang}コードを分析し、${targetLang}への移行レポートを作成してください。

【対象コード】
${code}

【レポート構成】
【作業時間削減効果】具体的な数値で冒頭に記載
【概要】3行以内
【詳細】箇条書き
【次のアクション】2〜3点

回答は${outLangName}で記述してください。`;

    const prompt = mode === "code" ? codePrompt : reportPrompt;

    // ── 4. モデル別API呼び出し ──
    let result;
    try {
      if (provider === "gemini") {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] }) }
        );
        const data = await res.json();
        result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!result) throw new Error("Geminiからの応答が空です: " + JSON.stringify(data).slice(0,200));

      } else if (provider === "anthropic") {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method:"POST",
          headers:{"Content-Type":"application/json","x-api-key":anthropicKey,"anthropic-version":"2023-06-01"},
          body: JSON.stringify({ model, max_tokens:4096, messages:[{ role:"user", content:prompt }] })
        });
        const data = await res.json();
        result = data?.content?.[0]?.text;
        if (!result) throw new Error("Claudeからの応答が空です: " + JSON.stringify(data).slice(0,200));

      } else if (provider === "openai") {
        const openaiKey = request.headers.get("X-OpenAI-Key") || env.OPENAI_API_KEY || "";
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${openaiKey}`},
          body: JSON.stringify({ model, max_tokens:4096, messages:[{ role:"user", content:prompt }] })
        });
        const data = await res.json();
        result = data?.choices?.[0]?.message?.content;
        if (!result) throw new Error("OpenAIからの応答が空です");
      }
    } catch(e) {
      return json({ error: `解析エラー: ${e.message}` }, 500, cors);
    }

    // ── 5. 領収書ログ ──
    const receiptId = `rcpt-${Date.now()}-${apiKey.slice(-6)}`;
    await env.LEGACY_KEYS.put(`receipt:${receiptId}`, JSON.stringify({
      receipt_id: receiptId, receipt_type: "machine_only",
      timestamp: new Date().toISOString(),
      api_key_suffix: apiKey.slice(-6),
      model, provider, mode, lang, target_lang: targetLang,
      byok_gemini: !!request.headers.get("X-Gemini-Key"),
      byok_anthropic: !!request.headers.get("X-Anthropic-Key"),
    }), { expirationTtl: 60*60*24*90 });

    return json({ result, status:"success", receipt_id: receiptId }, 200, cors);
  }
};

// ── Stripe Webhook処理 ──
async function handleStripeWebhook(request, env) {
  const body = await request.text();
  const sig  = request.headers.get("stripe-signature") || "";

  // 署名検証
  const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(body);

  // サブスクリプション開始時のみ処理
  if (event.type === "checkout.session.completed" || event.type === "customer.subscription.created") {
    const session = event.data.object;
    const email   = session.customer_email || session.customer_details?.email || "";

    if (!email) return new Response("No email", { status: 200 });

    // ft-key生成
    const ftKey = `ft-key-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

    // KVに保存
    await env.LEGACY_KEYS.put(ftKey, JSON.stringify({
      active: true,
      plan: "basic",
      email,
      created: new Date().toISOString(),
      stripe_session: session.id || "",
    }));

    // Resendでメール送信
    await sendKeyEmail(email, ftKey, env.RESEND_API_KEY);
  }

  return new Response("OK", { status: 200 });
}

// ── Resendメール送信 ──
async function sendKeyEmail(email, ftKey, resendKey) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: "Legacy Analyzer <onboarding@resend.dev>",
      to:   [email],
      subject: "🏛 Legacy Analyzer - APIキーのお知らせ",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#00d4ff;">🏛 Legacy Analyzer</h2>
          <p>ご購入ありがとうございます！</p>
          <p>あなたの専用APIキーはこちらです：</p>
          <div style="background:#1a1a2e;color:#00d4ff;padding:16px;border-radius:8px;font-family:monospace;font-size:1.1em;letter-spacing:1px;">
            ${ftKey}
          </div>
          <p style="margin-top:16px;">ツールのAPIキー欄にこのキーを入力してご利用ください。</p>
          <a href="https://furitsukatsuma.github.io/legacy-analyzer/" 
             style="display:inline-block;margin-top:12px;padding:10px 24px;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;border-radius:8px;text-decoration:none;">
            ツールを開く →
          </a>
          <p style="margin-top:24px;font-size:.8em;color:#888;">
            ご不明な点はこのメールにご返信ください。
          </p>
        </div>
      `,
    }),
  });
  return res.ok;
}

// ── Stripe署名検証（Web Crypto API使用） ──
async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts    = sigHeader.split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts["t"];
    const signature = parts["v1"];
    const signed    = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
    return hex === signature;
  } catch { return false; }
}

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), { status, headers:{"Content-Type":"application/json",...headers} });
}
