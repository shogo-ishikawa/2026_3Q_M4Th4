#pragma once
#include "raylib.h"
#include <string>
#include <vector>
#include <utility>
#include <algorithm>

namespace wdjp {

inline Font font{};
inline bool ready = false;

inline const std::vector<std::pair<std::string, std::string>>& Terms() {
    static const std::vector<std::pair<std::string, std::string>> terms = {
        {"HEAT", u8"加熱"},
        {"3. FIRE + HEAT", u8"3. 炎＋加熱"},
        {"HEAT UNLOCKED!", u8"新動詞「加熱」解放！"},
        {"GET POWER CORE TO UNLOCK", u8"結晶を取ると加熱が解放"},
        {"FIRE HIT - RESPAWN", u8"炎に触れた！スタートへ"},
        {"METAL LOCK", u8"金属ゲート"},
        {"3. FIRE + GROW", u8"3. 炎＋成長"},
        {"HOLD E TO HEAT", u8"Eキー長押しで加熱"},
        {"AI RULE LAB", u8"AIルール研究室"},
        {"BACK TO GAME", u8"ゲームに戻る"},
        {"OPEN AI LAB [TAB]", u8"AI研究室を開く [Tab]"},
        {"01  SELECT TARGET", u8"01  物体を選択"},
        {"02  COMBINE EFFECTS / MAX 3", u8"02  動作を組み合わせる（最大3個）"},
        {"03  FUSION QUEUE", u8"03  動作の組み合わせ"},
        {"AI GENERATED POWER", u8"AIが生成した能力"},
        {"GENERATE WITH AI", u8"AIで能力を生成"},
        {"Combine up to 3 effects with Ollama / qwen3.5:4b",
         u8"最大3つの動作をAIで組み合わせよう"},

        {"WATER", u8"水"},
        {"STONE", u8"石"},
        {"TREE", u8"木"},
        {"FIRE", u8"炎"},

        {"FLOAT", u8"浮遊"},
        {"MOVE", u8"移動"},
        {"GROW", u8"成長"},
        {"GLOW", u8"発光"},
        {"FREEZE", u8"凍結"},
        {"SOLID", u8"固体化"},
        {"SOLIDIFY", u8"固体化"},
        {"BRIDGE", u8"橋を作る"},
        {"PULSE", u8"脈動"},

        {"STAGE 01 / SEALED GOAL", u8"ステージ1 / 封印されたゴール"},
        {"STAGE 1 : SEALED GOAL", u8"ステージ1：封印されたゴール"},
        {"1. CROSS THE RIVER", u8"1. 川を渡ろう"},
        {"2. COLLECT THE CORE", u8"2. 結晶を回収しよう"},
        {"3. FIRE + GLOW + PULSE", u8"3. 炎＋発光＋脈動"},
        {"ASK AI TO UNLOCK", u8"AIで封印を解除しよう"},
        {"GATE OPEN! REACH GOAL", u8"ゲート開放！ゴールへ進もう"},

        {"POWER CORE", u8"エネルギー結晶"},
        {"CORE ACQUIRED!", u8"結晶を入手！"},
        {"LOCKED", u8"封印中"},
        {"OPEN", u8"開放"},
        {"GOAL", u8"ゴール"},
        {"RIVER", u8"川"},
        {"AI BRIDGE", u8"AIの橋"},

        {"PUZZLE CLEAR!", u8"ステージクリア！"},
        {"Press R to restart", u8"Rキーでやり直す"},
        {"WORLD RULE UPDATED!", u8"世界の法則が変化した！"},

        {"WASD: MOVE   R: RESET   TAB: AI LAB",
         u8"WASD：移動　R：リセット　Tab：AI研究室"},
        {"CLICK: SELECT   BACKSPACE: UNDO   TAB: GAME",
         u8"クリック：選択　Backspace：取り消し　Tab：戻る"},
        {"2/ENTER: GENERATE   T: TARGET   Q/E: EFFECT",
         u8"Enter：AI生成　T：物体変更　Q/E：動作変更"},

        {"No power generated yet", u8"能力はまだ生成されていません"},
        {"AI POWER: NONE", u8"AI能力：なし"},
        {"AI POWER APPLIED!", u8"AI能力を適用しました！"},
        {"Ready", u8"準備完了"},
        {"Thinking...", u8"AIが考えています..."},
        {"Request failed", u8"AIとの通信に失敗しました"},
        {"Invalid rule", u8"法則を適用できません"},
        {"Rule applied", u8"法則を適用しました"},
        {"Skyspanning Stone", u8"空を架ける石"},
        {"Blinking Ember", u8"瞬く火種"},
        {"ACTIVE", u8"有効"},
        {"INACTIVE", u8"無効"}
    };
    return terms;
}

inline std::string Translate(const std::string& text) {
    for (const auto& item : Terms()) {
        if (text == item.first) return item.second;
    }

    const std::string prefix = "AI POWER: ";
    if (text.compare(0, prefix.size(), prefix) == 0) {
        return std::string(u8"AI能力：") +
               Translate(text.substr(prefix.size()));
    }

    return text;
}

inline void Init() {
    if (ready) return;

    std::string characters = u8"日本語能力物体動作選択生成変更移動川石木炎水";
    characters += u8"浮遊 / FLOAT重力の影響を弱め、空中に浮かせる。単体では自由に移動できない。例：浮遊＋移動 → 空中を移動移動 / MOVE物体を別の場所へ動かす。方向や速度は組み合わせで変化。例：移動＋脈動 → 往復運動成長 / GROW大きさや形を変えて伸ばす。足場や壁などの用途を生み出す。例：成長＋浮遊 → 大きな空中足場発光 / GLOW物体から光を発生させる。暗所や光に反応する装置に使う。例：発光＋脈動 → 点滅する光凍結 / FREEZE熱を奪い、凍る物質を氷にする。水面を歩ける場所に変えられる。例：凍結＋成長 → 氷が広がる固体化 / SOLIDIFY温度を変えず、物体の形を固定。壁や足場になる硬い状態にする。例：固体化＋浮遊 → 空中の足場脈動 / PULSE光や大きさを周期的に変化させる。ほかの動作に繰り返しを加える。例：脈動＋発光 → 光が点滅する動作の説明組み合わせで新しい能力を作ろう※ 組み合わせ例には未実装の効果もあります。Hキーで説明を閉じる";
    for (const auto& item : Terms()) {
        characters += item.second;
    }

    std::vector<int> glyphs;
    for (int i = 32; i <= 126; ++i) glyphs.push_back(i);

    int count = 0;
    int* codes = LoadCodepoints(characters.c_str(), &count);
    if (codes) {
        for (int i = 0; i < count; ++i)
            glyphs.push_back(codes[i]);
        UnloadCodepoints(codes);
    }

    std::sort(glyphs.begin(), glyphs.end());
    glyphs.erase(std::unique(glyphs.begin(), glyphs.end()),
                 glyphs.end());

    const char* fontPath = "data/NotoSansJP.ttf";
#ifdef __APPLE__
    // In a Finder-launched .app, resource files live inside Contents/Resources.
    const std::string bundledFont =
        std::string(GetApplicationDirectory()) + "../Resources/data/NotoSansJP.ttf";
    if (FileExists(bundledFont.c_str())) fontPath = bundledFont.c_str();
#endif
    font = LoadFontEx(fontPath, 72,
                      glyphs.data(), static_cast<int>(glyphs.size()));
    ready = font.texture.id != 0;
}

inline void Shutdown() {
    if (ready) {
        UnloadFont(font);
        ready = false;
    }
}

inline void Text(const char* raw, int x, int y,
                 int size, Color color) {
    // TEXT_VISIBILITY_FIX_V1
    if (!raw) return;

    const std::string translated = Translate(raw);

    if (!ready) {
        DrawText(raw, x, y, size, color);
        return;
    }

    const float px = static_cast<float>(x);
    const float py = static_cast<float>(y);
    const float fs = static_cast<float>(size);

    // Choose a contrasting outline automatically.
    const int brightness =
        (static_cast<int>(color.r) * 299 +
         static_cast<int>(color.g) * 587 +
         static_cast<int>(color.b) * 114) / 1000;

    const Color outline = brightness >= 140
        ? Color{18, 39, 27, 245}
        : Color{255, 251, 230, 245};

    const Vector2 offsets[] = {
        {-2.0f,  0.0f},
        { 2.0f,  0.0f},
        { 0.0f, -2.0f},
        { 0.0f,  2.0f},
        {-1.0f, -1.0f},
        { 1.0f, -1.0f},
        {-1.0f,  1.0f},
        { 1.0f,  1.0f}
    };

    // Draw thick, high-contrast text outlines.
    for (const Vector2& offset : offsets) {
        DrawTextEx(
            font,
            translated.c_str(),
            Vector2{px + offset.x, py + offset.y},
            fs, 1.0f, outline
        );
    }

    // Draw twice to strengthen the main strokes.
    DrawTextEx(
        font, translated.c_str(),
        Vector2{px, py}, fs, 1.0f, color
    );

    DrawTextEx(
        font, translated.c_str(),
        Vector2{px + 1.0f, py}, fs, 1.0f, color
    );
}

} // namespace wdjp
inline void DrawJapaneseText(const char* text,
                             int x, int y, int size, Color color) {
    wdjp::Text(text, x, y, size, color);
}
