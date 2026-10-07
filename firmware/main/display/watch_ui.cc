#include "watch_ui.h"
#include "watch_icons.h"
#include "watch_dotmatrix.h"   /* the app-pixels look; the ChatGPT pages are moving to it */
#include "bloub/bloub_shapes.h"
#include "voice_character.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <utility>

LV_FONT_DECLARE(font_noto_sans_basic_30_4);

namespace {
constexpr uint32_t kAccent = 0x10A37F;
constexpr uint32_t kAmoledText = 0xF4F1FF;
constexpr uint32_t kAmoledMuted = 0xA9B8C5;
using watch_palette::kUiPalettes;
using watch_palette::Palette;
// The round screen's geometry, shared with the design mockups: centre, and the
// radius everything drawn has to stay inside of.
constexpr int kCenter = 180, kSafeR = 176;
constexpr int kDotNav = 44;    // smallest comfortable touch target here
constexpr int kDotRowH = 46;   // app-pixels list row
// The sleep choices, named once. The brightness row used to format its own
// value ("60 s") while this page said "1 minute" for the same setting.
struct SleepOpt { int seconds; const char* label; };
constexpr SleepOpt kSleepOpts[]={{0,"Always on"},{30,"30 seconds"},{60,"1 minute"},
                                 {120,"2 minutes"},{300,"5 minutes"}};
const char* SleepLabel(int seconds){
    for(const auto& o:kSleepOpts) if(o.seconds==seconds) return o.label;
    return "Custom";
}
using voice_character::kShapeNames;
using voice_character::kColourNames;
/* Straight ahead and expressionless. bloub's NEUTRAL expression is the rest
 * gaze measured off the reference video - a three-quarter view - which at
 * preview size reads as looking off to one side and leaves only one eye
 * visible, so it does not read as neutral at all. Neutral here means the
 * plain front-facing face. */
static const bloub_gaze_t kNeutralPreview={0.0f,0.0f,0.0f};
lv_obj_t* ShapePreview(lv_obj_t* parent, int shape, uint32_t color, int size=44, int scale=18) {
    auto* buf=static_cast<lv_color16_t*>(dm_alloc(size*size*sizeof(lv_color16_t)));
    if(!buf) return nullptr;
    memset(buf,0,size*size*sizeof(lv_color16_t));
    auto canvas=lv_canvas_create(parent);
    if(!canvas){dm_release(buf);return nullptr;}
    lv_canvas_set_buffer(canvas,buf,size,size,LV_COLOR_FORMAT_RGB565);
    lv_obj_set_size(canvas,size,size);
    lv_obj_add_event_cb(canvas,dm_free_buffer,LV_EVENT_DELETE,buf);
    bloub_face_cfg_t face{};face.radii=SHAPE_PROFILES[shape];face.gaze=&kNeutralPreview;
    face.split=BLOUB_EYE_SPLIT;face.scale=scale;face.cx=face.cy=size/2.0f;face.sx=face.sy=1;face.eye_alpha=1;
    for(int e=0;e<2;++e){face.eyes[e].w=.236f;face.eyes[e].h=.447f;face.eyes[e].open=1;}
    bloub_draw_face(reinterpret_cast<uint16_t*>(buf),size,size,&face,lv_color_to_u16(lv_color_hex(color)),0);
    return canvas;
}
int ChordHalf(int y) {
    const int dy = y - kCenter;
    const int inside = kSafeR * kSafeR - dy * dy;
    return inside > 0 ? static_cast<int>(std::sqrt(static_cast<float>(inside))) : 0;
}
void Background(lv_obj_t* obj) {
    lv_obj_set_style_bg_color(obj, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
}
// Render an icon at its source size, except 24px controls placed inside a 96px
// home tile which are upscaled to 48px so they read at the same visual weight as
// the 52px ChatGPT icon. The layout size matches the rendered size so centering
// is exact. Row/control parents (32px chip, 62px row) stay at native 24px.
void Icon(lv_obj_t* parent, const lv_image_dsc_t* source) {
    auto image = lv_image_create(parent);
    lv_image_set_src(image, source);
    if (source->header.w == 24) {
        const int pw = lv_obj_get_style_width(parent, LV_PART_MAIN);
        const int ph = lv_obj_get_style_height(parent, LV_PART_MAIN);
        if (pw >= 96 && ph >= 96) {
            lv_image_set_scale(image, 512);            // 24 -> 48
            lv_obj_set_size(image, 48, 48);            // match rendered size
        }
    }
    // Alpha-only icons carry shape and are tinted here; a full-colour one
    // (the Codex mark) already has its own gradient and must be left alone.
    if (source->header.cf == LV_COLOR_FORMAT_A8) {
        lv_obj_set_style_image_recolor(image, lv_color_white(), 0);
        lv_obj_set_style_image_recolor_opa(image, LV_OPA_COVER, 0);
    }
    lv_obj_remove_flag(image, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_center(image);
}
// Click handler. The lambda is heap-allocated and owned by the button; we free
// it on LV_EVENT_DELETE so a lambda that captures `this` cannot outlive its
// button. We copy the function before invoking so a click handler that deletes
// its own button mid-navigation cannot leave us holding a freed function.
void Click(lv_obj_t* obj, std::function<void()> fn) {
    if (!fn) return;
    auto owned = new std::function<void()>(std::move(fn));
    lv_obj_add_event_cb(obj, [](lv_event_t* e) {
        auto fn = static_cast<std::function<void()>*>(lv_event_get_user_data(e));
        if (lv_event_get_code(e) == LV_EVENT_DELETE) { delete fn; return; }
        if (lv_event_get_code(e) == LV_EVENT_CLICKED) {
            auto invoke = *fn;
            invoke();
        }
    }, LV_EVENT_ALL, owned);
}
// Shorten text until it fits `room` pixels, marking the cut with a dot. The
// dot-matrix drawer has no truncation of its own, so without this long names
// run off the side of the row and out of the circle.
std::string Fit(const char* text, const dm_style_t* st, int room) {
    std::string s(text);
    if (dm_width(s.c_str(), st) <= room) return s;
    while (!s.empty() && dm_width((s + ".").c_str(), st) > room) s.pop_back();
    return s.empty() ? s : s + ".";
}
bool IsPrintableAscii(char c) { return c >= 0x20 && c <= 0x7E; }
bool IsHex(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
}

WatchUi::WatchUi(lv_obj_t* voice, std::shared_ptr<LvglFont> font, Callback callback)
    : voice_(voice), font_owner_(std::move(font)),
      font_(font_owner_ == nullptr ? nullptr : font_owner_->font()), callback_(std::move(callback)) {
    large_text_ = lv_obj_get_width(lv_obj_get_parent(voice)) > 360;
    shell_ = Box(lv_obj_get_parent(voice), lv_obj_get_x(voice), lv_obj_get_y(voice),
                 360, 360, 0x000000, 0);
    lv_obj_set_style_text_font(shell_, font_, 0);
    lv_obj_set_style_text_color(shell_, lv_color_white(), 0);
    Background(shell_);
    Show(Page::Home);
}
WatchUi::~WatchUi() { lv_obj_delete(shell_); }
void WatchUi::Emit(Action a, int n, const std::string& text, const std::string& secret) {
    if (callback_) callback_(a, n, text, secret);
}
void WatchUi::SetFont(std::shared_ptr<LvglFont> font) {
    if (font == nullptr || font->font() == nullptr) return;
    font_owner_ = std::move(font);
    font_ = font_owner_->font();
    if (shell_ != nullptr) lv_obj_set_style_text_font(shell_,
        large_text_ && page_ != Page::Keyboard ? &font_noto_sans_basic_30_4 : font_, 0);
}
lv_obj_t* WatchUi::Box(lv_obj_t* p, int x, int y, int w, int h, uint32_t c, int r) {
    auto o = lv_obj_create(p);
    lv_obj_set_pos(o, x, y); lv_obj_set_size(o, w, h);
    lv_obj_set_style_radius(o, r, 0);
    lv_obj_set_style_bg_color(o, lv_color_hex(c), 0);
    lv_obj_set_style_border_width(o, 0, 0); lv_obj_set_style_pad_all(o, 0, 0);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}
lv_obj_t* WatchUi::Label(lv_obj_t* p, const char* text, int width) {
    auto l = lv_label_create(p); lv_label_set_text(l, text);
    lv_obj_set_style_text_color(l, lv_color_white(), 0);
    lv_obj_remove_flag(l, LV_OBJ_FLAG_CLICKABLE);
    if (width) { lv_obj_set_width(l, width); lv_label_set_long_mode(l, LV_LABEL_LONG_DOT); }
    return l;
}
lv_obj_t* WatchUi::Button(lv_obj_t* p, int x, int y, int w, int h, const char* text,
                         const lv_image_dsc_t* icon, std::function<void()> fn, uint32_t color) {
    auto b = Box(p,x,y,w,h,color, std::min(26,h/2));
    lv_obj_remove_flag(b, LV_OBJ_FLAG_CLICKABLE);
    if (fn) {
        lv_obj_add_flag(b, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_style_bg_color(b, lv_color_hex(0x2E2E2E), LV_STATE_PRESSED);
    }
    if (icon) Icon(b,icon);
    else { auto l=Label(b,text,w-8); lv_obj_set_style_text_align(l,LV_TEXT_ALIGN_CENTER,0); lv_obj_center(l); }
    Click(b,std::move(fn)); return b;
}
void WatchUi::Header(const char* title, Page back) {
    if(full_page_){
        Button(shell_,24,64,kDotNav,kDotNav,"",&watch_icons::back,
               [this,back]{Show(back);},0x15232C);
        auto heading=Label(shell_,title,298);
        lv_obj_set_style_text_font(heading,&font_noto_sans_basic_30_4,0);
        lv_obj_set_style_text_color(heading,lv_color_hex(Palette(info_.ui_theme).accent),0);
        lv_obj_set_pos(heading,78,66);
        Box(shell_,24,118,362,1,Palette(info_.ui_theme).border,0);
        return;
    }
    if(dot_style_){
        // Back arrow and title on ONE line. ONE size on every page: the old
        // shrink-to-fit stepped both pitch and dot, so a long title came out
        // smaller AND fainter than a short one - "BRIGHTNESS" and "VOLUME" are
        // sibling pages and looked nothing alike.
        //
        // The pair is left-aligned to the list's own left edge rather than
        // centred. Centring is what the mockup does, but its titles are five
        // or six characters; ours run to ten, and only the full chord holds
        // "BRIGHTNESS" at a readable size. It also lines the heading up with
        // the rows underneath it.
        dm_style_t st={full_page_?5:3,full_page_?4:2,1,
                       full_page_?0x39DCAEu:kAccent,0x101010};
        const int cy=full_page_?86:70;
        const int x0=full_page_?24:66;
        const int title_x=x0+kDotNav+10;
        // Right limit measured at the title's TOP edge, the corner furthest
        // from centre and so the first to leave the circle.
        const int room=(full_page_?390:kCenter+ChordHalf(cy-DM_H*st.pitch/2))-8-title_x;
        Button(shell_,x0,cy-kDotNav/2,kDotNav,kDotNav,"",&watch_icons::back,[this,back]{Show(back);},0x1A1A1A);
        dm_text(shell_,title_x,cy-DM_H*st.pitch/2,Fit(title,&st,room).c_str(),&st);
        Box(shell_,full_page_?24:84,cy+(full_page_?31:26),full_page_?362:192,1,0x2A2A33,0);
        return;
    }
   Button(shell_,66,38,44,44,"",&watch_icons::back,[this,back]{Show(back);});
    auto l=Label(shell_,title,154);lv_obj_set_pos(l,116,49);
}
lv_obj_t* WatchUi::Column() {
    // Let lists reach the bottom of the AMOLED screen. UpdateNotice() shortens
    // them only while an actual notice is visible.
    auto c=Box(shell_,full_page_?24:62,full_page_?130:(dot_style_?100:90),
               full_page_?362:236,full_page_?372:(dot_style_?212:220),0,0);
    lv_obj_set_style_bg_opa(c,LV_OPA_TRANSP,0);
    lv_obj_add_flag(c,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(c,LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(c,dot_style_?(full_page_?8:0):10,0);
    // Leave room for the panel's curved lower edge when a list reaches its end.
    if(full_page_) lv_obj_set_style_pad_bottom(c,39,0);
    lv_obj_set_scroll_dir(c,LV_DIR_VER);
    lv_obj_set_scrollbar_mode(c,LV_SCROLLBAR_MODE_OFF);
    return column_=c;
}
// Row is read-only when `fn` is empty: no chevron, no navigation behavior.
// The bool is captured before std::move so the chevron stays consistent.
void WatchUi::Row(const char* title,const char* value,std::function<void()> fn,bool selected) {
    // Keep the name and value on one line when they fit. Long pairs use two
    // lines with breathing room, at the same text size as every other row.
    const int row_w=full_page_?362:236;
    const bool has_value=value!=nullptr&&value[0]!=0;
    const int row_h=full_page_?76:kDotRowH;
    const auto& palette=Palette(info_.ui_theme);
    auto r=Box(column_,0,0,row_w,row_h,
               full_page_?(selected?palette.selected:palette.card):(selected?0x141414:0x000000),
               full_page_?8:2);
    lv_obj_set_style_bg_opa(r,full_page_||selected?LV_OPA_COVER:LV_OPA_TRANSP,0);
    if(full_page_){
        lv_obj_set_style_border_width(r,1,0);
        lv_obj_set_style_border_color(r,lv_color_hex(selected?palette.accent:palette.border),0);
        if(fn){
            lv_obj_set_style_bg_color(r,lv_color_hex(palette.selected),LV_STATE_PRESSED);
            lv_obj_set_style_border_color(r,lv_color_hex(palette.accent),LV_STATE_PRESSED);
        }
    }
    if(selected){auto s=Box(r,0,0,3,row_h,full_page_?palette.accent:kAccent,0);lv_obj_remove_flag(s,LV_OBJ_FLAG_CLICKABLE);}
    if(fn) Click(r,std::move(fn));
    if(full_page_){
        auto name=Label(r,title);
        lv_obj_set_style_text_font(name,&font_noto_sans_basic_30_4,0);
        lv_obj_set_style_text_color(name,lv_color_hex(kAmoledText),0);
        lv_obj_update_layout(name);
        auto detail=has_value?Label(r,value):nullptr;
        if(detail){
            lv_obj_set_style_text_font(detail,&font_noto_sans_basic_30_4,0);
            lv_obj_set_style_text_color(detail,lv_color_hex(selected?palette.accent:kAmoledMuted),0);
            lv_obj_update_layout(detail);
        }
        const bool stacked=detail&&lv_obj_get_width(name)+lv_obj_get_width(detail)+44>row_w;
        if(stacked){
            lv_obj_set_height(r,96);
            if(selected) lv_obj_set_height(lv_obj_get_child(r,0),96);
            lv_obj_set_width(name,row_w-32);
            lv_label_set_long_mode(name,LV_LABEL_LONG_DOT);
            lv_obj_set_pos(name,16,6);
            lv_obj_set_width(detail,row_w-32);
            lv_label_set_long_mode(detail,LV_LABEL_LONG_DOT);
            lv_obj_set_pos(detail,16,49);
        }else{
            lv_obj_set_width(name,row_w-(detail?lv_obj_get_width(detail)+44:32));
            lv_label_set_long_mode(name,LV_LABEL_LONG_DOT);
            lv_obj_set_pos(name,16,19);
            if(detail) lv_obj_set_pos(detail,row_w-16-lv_obj_get_width(detail),19);
        }
        return;
    }
    constexpr int kPadL=14,kPadR=12,kGap=16;
    dm_style_t n={2,1,1,selected?0xFFFFFFu:0x8E8E93u,0x101010u};
    dm_style_t v={2,1,1,selected?kAccent:0x5A5A5Fu,0x101010u};
    // A value gets at most half the row; past that it is the name that
    // carries the meaning, so the value is the one cut.
    const std::string shown=has_value?Fit(value,&v,(236-kPadL-kPadR-kGap)/2):std::string();
    const int vw=shown.empty()?0:dm_width(shown.c_str(),&v);
    const int name_room=236-kPadL-kPadR-(vw?vw+kGap:0);
    dm_text(r,kPadL,(kDotRowH-DM_H*n.pitch)/2,Fit(title,&n,name_room).c_str(),&n);
    if(vw) dm_text(r,236-kPadR-vw,(kDotRowH-DM_H*v.pitch)/2,shown.c_str(),&v);
}
void WatchUi::Show(Page page) {
    page_=page;
    full_page_=large_text_ && page!=Page::Voice;
    if(large_text_){
        lv_obj_set_pos(shell_,full_page_?0:lv_obj_get_x(voice_),
                       full_page_?0:lv_obj_get_y(voice_));
        lv_obj_set_size(shell_,full_page_?410:360,full_page_?502:360);
        lv_obj_set_style_text_font(shell_,page==Page::Keyboard?font_:&font_noto_sans_basic_30_4,0);
    }
    // Every page wears the app-pixels language except three: Home keeps its
    // icon tiles by request, the call screen is the character, and the keyboard
    // keeps a real typeface because the dot-matrix drawer folds lowercase to
    // uppercase - wrong on a key cap, dangerous in a password field.
    switch(page){
    case Page::Home: case Page::Voice: case Page::Keyboard:
        dot_style_=false;break;
    default: dot_style_=true;break;
    }
    if(page==Page::Voice){
        lv_obj_add_flag(shell_,LV_OBJ_FLAG_HIDDEN);lv_obj_remove_flag(voice_,LV_OBJ_FLAG_HIDDEN);return;
    }
    lv_obj_add_flag(voice_,LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(shell_,LV_OBJ_FLAG_HIDDEN);lv_obj_move_foreground(shell_);
    lv_obj_clean(shell_);column_=clock_=date_=value_=field_=keys_=wifi_status_=notice_=error_=nullptr;
    keyboard_done_={};
    // App-pixels pages are pure black with no gradient; the rest keep the navy
    // watch background they have always had.
    if(dot_style_){lv_obj_set_style_bg_color(shell_,lv_color_hex(full_page_?Palette(info_.ui_theme).background:0x000000),0);lv_obj_set_style_bg_grad_dir(shell_,LV_GRAD_DIR_NONE,0);}
    else if(full_page_){
        lv_obj_set_style_bg_color(shell_,lv_color_hex(Palette(info_.ui_theme).background),0);
        lv_obj_set_style_bg_grad_dir(shell_,LV_GRAD_DIR_NONE,0);
    }else Background(shell_);
    switch(page){
    case Page::Home: {
        if(full_page_){
            clock_=Label(shell_,time_.c_str());
            lv_obj_set_style_text_color(clock_,lv_color_hex(Palette(info_.ui_theme).accent),0);
            lv_obj_align(clock_,LV_ALIGN_TOP_MID,0,48);
            const char* names[]={"ChatGPT","Settings","Clock"};
            const lv_image_dsc_t* icons[]={&watch_icons::codex,&watch_icons::settings,&watch_icons::clock};
            const uint32_t colors[]={0xFFFFFF,0x424D61,0x3354A4};
            for(int i=0;i<3;++i){
                const auto& palette=Palette(info_.ui_theme);
                auto card=Box(shell_,24,130+i*110,362,96,palette.card,24);
                lv_obj_set_style_border_width(card,1,0);
                lv_obj_set_style_border_color(card,lv_color_hex(palette.border),0);
                auto icon_box=Box(card,0,0,96,96,colors[i],24);
                lv_obj_remove_flag(icon_box,LV_OBJ_FLAG_CLICKABLE);
                Icon(icon_box,icons[i]);
                auto label=Label(card,names[i],230);
                lv_obj_set_pos(label,118,27);
                Click(card,[this,i]{
                    if(i==0) Show(Page::Voice);
                    else if(i==1){Show(Page::Settings);Emit(Action::Refresh);}
                    else Show(Page::Clock);
                });
            }
            break;
        }
        clock_=Label(shell_,time_.c_str());lv_obj_align(clock_,LV_ALIGN_TOP_MID,0,30);
        // ChatGPT: show voice page but don't auto-connect; user taps orb to connect
        // White tile: the logo's own rounded square, with the glyph on top.
        Button(shell_,74,82,96,96,"",&watch_icons::codex,[this]{Show(Page::Voice);},0xFFFFFF);
        Button(shell_,190,82,96,96,"",&watch_icons::settings,[this]{Show(Page::Settings);Emit(Action::Refresh);},0x424D61);
        Button(shell_,74,large_text_?216:212,96,96,"",&watch_icons::clock,[this]{Show(Page::Clock);},0x3354A4);
        // Home tile labels — 3 tiles centred in the chord-safe area
        const char* names[]={"ChatGPT","Settings","Clock"};
        for(int i=0;i<3;++i){
            auto l=Label(shell_,names[i],large_text_?130:80);
            lv_obj_set_style_text_align(l,LV_TEXT_ALIGN_CENTER,0);
            lv_obj_set_pos(l,(large_text_?57:82)+(i%2)*116,
                           (large_text_?180:180)+(i/2)*(large_text_?134:130));
        }
        break;
    }
    case Page::Settings:
        Header("Settings",Page::Home);Column();
        Row("Wi-Fi",info_.network.empty()?"Not connected":info_.network.c_str(),[this]{Show(Page::Wifi);Emit(Action::ScanWifi);});
        if(full_page_) Row("Theme",Palette(info_.ui_theme).name,[this]{Show(Page::Themes);});
        Row("Brightness",nullptr,[this]{Show(Page::Brightness);});
        Row("Volume",nullptr,[this]{Show(Page::Volume);});
        Row("About",info_.version.c_str(),[this]{Show(Page::About);});break;
    case Page::Themes:
        Header("Theme",Page::Settings);Column();
        for(int i=0;i<static_cast<int>(std::size(kUiPalettes));++i){
            Row(kUiPalettes[i].name,nullptr,[this,i]{
                info_.ui_theme=i;
                Emit(Action::SelectTheme,i);
                Show(Page::Themes);
            },info_.ui_theme==i);
            if(full_page_){
                auto row=lv_obj_get_child(column_,lv_obj_get_child_cnt(column_)-1);
                auto swatch=Box(row,314,23,30,30,kUiPalettes[i].accent,5);
                lv_obj_remove_flag(swatch,LV_OBJ_FLAG_CLICKABLE);
            }
        }
        break;
    case Page::Brightness: {
        Header("Brightness",Page::Settings);
        Slider(true);
        // Sleep sits under the slider, inside the chord-safe band.
        column_ = Box(shell_, full_page_?24:62, full_page_?340:244,
                      full_page_?362:236, full_page_?76:kDotRowH, 0, 0);
        lv_obj_set_style_bg_opa(column_, LV_OPA_TRANSP, 0);
        // "Sleep", not "Sleep timeout": the long name left no room for the
        // value beside it, and the value was silently dropped.
        Row("Sleep", SleepLabel(info_.sleep_seconds),
            [this]{ Show(Page::Sleep); });
        break;
    }
    case Page::Volume: Header("Volume",Page::Settings);Slider(false);break;
    case Page::Wifi:
        Header("Wi-Fi",Page::Settings);Column();
        wifi_status_=Label(column_,info_.wifi_status.empty()?(info_.network.empty()?"Not connected":info_.network.c_str()):info_.wifi_status.c_str(),full_page_?362:236);
        for(const auto& ssid:info_.networks){
            const bool saved=std::find(info_.saved_networks.begin(),info_.saved_networks.end(),ssid)!=info_.saved_networks.end();
            const bool connected=ssid==info_.network;
            Row(ssid.c_str(),connected?nullptr:saved?"Saved":"Join",
                [this,ssid]{ChooseNetwork(ssid);},connected);
        }
        Row(full_page_?"Other Wi-Fi":"Other network", nullptr,[this]{
            OpenKeyboard(FieldKind::Ssid,"Wi-Fi name","",[this](const std::string& name){ ChooseNetwork(name); });
        });
        Row("Scan again",nullptr,[this]{Emit(Action::ScanWifi);});
        Row("Phone setup",nullptr,[this]{Show(Page::WifiSetup);});break;
    case Page::WifiSetup: {
        Header("Setup",Page::Wifi);
        if(full_page_){
            const char* lines[]={"Call will end","Join watch Wi-Fi","Open this address"};
            for(int i=0;i<3;++i){
                auto line=Label(shell_,lines[i],362);
                lv_obj_set_style_text_align(line,LV_TEXT_ALIGN_CENTER,0);
                lv_obj_set_style_text_color(line,lv_color_hex(kAmoledText),0);
                lv_obj_set_pos(line,24,151+i*51);
            }
            auto address=Label(shell_,"192.168.4.1",362);
            lv_obj_set_style_text_align(address,LV_TEXT_ALIGN_CENTER,0);
            lv_obj_set_style_text_color(address,lv_color_hex(Palette(info_.ui_theme).accent),0);
            lv_obj_set_pos(address,24,313);
            auto start=Button(shell_,55,383,300,68,"Start setup",nullptr,
                              [this]{Emit(Action::SetupWifi);},Palette(info_.ui_theme).accent);
            lv_obj_set_style_text_color(lv_obj_get_child(start,0),lv_color_hex(0x071015),0);
            break;
        }
        // Shorter lines than the old paragraph: the dot-matrix letters are
        // wide, and the chord at this height will not hold a full sentence.
        dm_style_t body={full_page_?4:2,full_page_?3:1,1,
                         full_page_?0xF0F0F2u:0x8E8E93u,0x101010u};
        const char* small_lines[]={"THIS ENDS THE CALL","JOIN THE DEVICE","HOTSPOT, THEN OPEN"};
        const char* large_lines[]={"CALL WILL END","JOIN WATCH WI-FI","OPEN ADDRESS"};
        const int center=full_page_?205:kCenter;
        for(int i=0;i<3;++i) dm_text_center(shell_,center,
            (full_page_?157:122)+i*(full_page_?48:22),
            full_page_?large_lines[i]:small_lines[i],&body);
        dm_style_t addr={full_page_?4:3,full_page_?3:2,1,0xFFFFFFu,0x101010u};
        dm_text_center(shell_,center,full_page_?315:196,"192.168.4.1",&addr);
        auto b=Box(shell_,full_page_?55:90,full_page_?383:250,
                   full_page_?300:180,full_page_?68:48,0x000000,24);
        lv_obj_set_style_border_width(b,2,0);
        lv_obj_set_style_border_color(b,lv_color_hex(kAccent),0);
        lv_obj_add_flag(b,LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_style_bg_color(b,lv_color_hex(0x0E2B22),LV_STATE_PRESSED);
        dm_style_t cap={full_page_?4:2,full_page_?3:1,1,kAccent,0x101010};
        dm_text_center(b,full_page_?150:90,
                       ((full_page_?68:48)-DM_H*cap.pitch)/2,"START SETUP",&cap);
        Click(b,[this]{Emit(Action::SetupWifi);});
        break;
    }
    case Page::Sleep: {
        Header("Sleep", Page::Brightness); Column();
        for (const auto& opt : kSleepOpts) {
            // No chevron: tapping the row is the affordance; a > would imply
            // a sub-page that does not exist.
            Row(opt.label,nullptr, [this, opt] {
                info_.sleep_seconds = opt.seconds;
                Emit(Action::Sleep, opt.seconds);
                Show(Page::Brightness);
            }, info_.sleep_seconds == opt.seconds);
        }
        break;
    }
    case Page::Clock: {
        Header("Clock",Page::Home);
        DrawClockFace();
        if(full_page_){
            auto status=Label(shell_,info_.connected?"Wi-Fi connected":"Wi-Fi offline",362);
            lv_obj_set_style_text_align(status,LV_TEXT_ALIGN_CENTER,0);
            lv_obj_set_style_text_color(status,lv_color_hex(kAmoledMuted),0);
            lv_obj_set_pos(status,24,340);
            break;
        }
        dm_style_t st={full_page_?4:2,full_page_?3:1,1,
                       full_page_?0xD2D2D7u:0x5A5A5Fu,0x101010u};
        dm_text_center(shell_,full_page_?205:kCenter,full_page_?340:258,
                       info_.connected?"WI-FI CONNECTED":
                       full_page_?"WI-FI OFFLINE":"WAITING FOR WI-FI",&st);
        break;
    }
    case Page::About:{
        Header("About",Page::Settings);Column();
        Row("Firmware",info_.version.c_str(),{});
        // Short labels because a row holds 16 characters between name and
        // value; the sentence is the notice card's job. "A"/"B" because ota_0
        // means nothing to the wearer, and the font has no underscore anyway.
        if(info_.rolled_back)
            Row("Update","Failed",{});
        else if(!info_.slot.empty())
            Row("Slot",info_.slot=="ota_1"?"B":"A",{});
        Row("Voice","WebRTC",{});
        std::string battery=info_.battery<0?"Not available":std::to_string(info_.battery)+"%"+(info_.charging?" - charging":"");
        Row("Battery",battery.c_str(),{});
        Row("Display",large_text_?"410x502":"360x360",{});break;
    }
    case Page::CodexSettings:
        Header("ChatGPT",Page::Voice);Column();
        Row("Shape",kShapeNames[std::clamp(info_.shape,0,voice_character::kShapeCount-1)],[this]{Show(Page::Shapes);});
        Row("Colour",kColourNames[std::clamp(info_.colour,0,voice_character::kColorCount-1)],[this]{Show(Page::Colours);});
        Row("Voice",info_.voice.empty()?"Default":info_.voice.c_str(),[this]{Show(Page::Voices);});
        Row("Model",info_.model.c_str(),[this]{model_return_=Page::CodexSettings;Show(Page::Models);Emit(Action::Models);});
        Row("Chat",info_.temporary_chat?"Temporary":info_.chat.c_str(),[this]{Show(Page::Chats);Emit(Action::Models);});
        Row("Reasoning",info_.reasoning.c_str(),[this]{Show(Page::Reasoning);});
        Row("Captions",info_.captions?"On":"Off",[this]{
            info_.captions=!info_.captions;
            Emit(Action::Captions,info_.captions?1:0);
            Show(Page::CodexSettings);
        });break;
    case Page::Shapes: {
        Header("Shape",Page::CodexSettings);Column();
        // Four rows fill the space between the header rule and the bottom of
        // the circle; the rest stay reachable by swiping. No counter: the list
        // is short enough to see, and the number was just sitting in space.
        lv_obj_set_height(column_,full_page_?372:208);
        for(int i=0;i<voice_character::kShapeCount;++i){
            Row(kShapeNames[i],nullptr,[this,i]{
                info_.shape=i; Emit(Action::SelectShape,i); Show(Page::Shapes);
            },info_.shape==i);
            auto row=lv_obj_get_child(column_,lv_obj_get_child_cnt(column_)-1);
            lv_obj_set_height(row,full_page_?76:52);
            // Row() creates the title canvas immediately after the optional
            // selection stripe. Give the larger face a dedicated left lane so
            // it never covers the first letters of the name.
            const uint32_t title_index=info_.shape==i?1:0;
            if(lv_obj_get_child_cnt(row)>title_index){
                lv_obj_set_x(lv_obj_get_child(row,title_index),full_page_?70:50);
                lv_obj_set_y(lv_obj_get_child(row,title_index),full_page_?24:15);
            }
            if(auto preview=ShapePreview(row,i,info_.shape==i?0xF1EFE9:0x8E8E93,
                                         full_page_?60:44,full_page_?24:18))
                lv_obj_set_pos(preview,full_page_?4:2,full_page_?8:4);
        }
        break;
    }
    case Page::Colours: {
        Header("Colour",Page::CodexSettings);
        const int row_n[]={3,4,4}, row_y[]={full_page_?190:140,
                                             full_page_?278:202,
                                             full_page_?366:264}; int at=0;
        // The rows have to account for every colour: one short and the last is
        // unreachable, one over and this walks off the end of the palette.
        static_assert(3+4+4==voice_character::kColorCount,
                      "the colour grid's rows no longer add up to the palette");
        for(int row=0;row<3;++row) for(int col=0;col<row_n[row];++col,++at){
            const int gap=full_page_?78:54;
            const int size=full_page_?62:46;
            const int cx=(full_page_?205:180)+(col*gap-(row_n[row]-1)*gap/2);
            auto swatch=Box(shell_,cx-size/2,row_y[row]-size/2,size,size,
                            voice_character::kColors[at],12);
            Click(swatch,[this,at]{info_.colour=at;Emit(Action::SelectColour,at);Show(Page::Colours);});
            if(info_.colour==at){
                lv_obj_set_style_border_width(swatch,2,0);
                lv_obj_set_style_border_color(swatch,lv_color_white(),0);
                lv_obj_set_style_outline_width(swatch,3,0);
                lv_obj_set_style_outline_color(swatch,lv_color_black(),0);
            }
        }
        break;
    }
    case Page::Voices: {
        Header("Voice",Page::CodexSettings);Column();
        // Names come from the app-server's v1 realtime voice set, which is what
        // a v3 ChatGPT Voice call accepts. "Default" clears the saved choice.
        const char* voices[]={"Default","Cove","Juniper","Maple","Spruce","Ember",
                              "Vale","Breeze","Arbor","Sol"};
        for(const auto& voice:voices){
            const bool current=info_.voice.empty()?strcmp(voice,"Default")==0:info_.voice==voice;
            Row(voice,nullptr,[this,voice]{
                info_.voice=strcmp(voice,"Default")==0?std::string():voice;
                Emit(Action::SelectVoice,0,info_.voice);
                Show(Page::CodexSettings);
            },current);
        }
        break;
    }
    case Page::Chats: {
        Header("Chat",Page::CodexSettings);Column();
        // Temporary chats stay out of Codex, so the picker is pointless then.
        Row("Temporary",info_.temporary_chat?"On":"Off",[this]{
            info_.temporary_chat=!info_.temporary_chat;
            Emit(Action::TemporaryChat,info_.temporary_chat?1:0);
            Show(Page::Chats);
        });
        if(info_.temporary_chat){
            auto l=Label(column_,"Calls stay out of Codex\nuntil you turn this off.",full_page_?362:236);
            lv_label_set_long_mode(l,LV_LABEL_LONG_WRAP);
            break;
        }
        Row("New chat",nullptr,[this]{
            Emit(Action::SelectChat,0);Show(Page::CodexSettings);
        },info_.chat=="New chat");
        if(info_.chats.empty()){
            auto l=Label(column_,"No recent saved chats.",full_page_?362:236);
            lv_label_set_long_mode(l,LV_LABEL_LONG_WRAP);
        }
        for(size_t i=0;i<info_.chats.size();++i){
            const bool current=info_.chat==info_.chats[i];
            const char* folder = i < info_.chat_folders.size() && !info_.chat_folders[i].empty()
                                     ? info_.chat_folders[i].c_str()
                                     : nullptr;
            Row(info_.chats[i].c_str(),folder,[this,i]{
                Emit(Action::SelectChat,static_cast<int>(i+1));Show(Page::CodexSettings);
            },current);
        }
        break;
    }
    case Page::Models:
        Header("Model",model_return_);Column();
        if(info_.models.size()<=1) {auto l=Label(column_,"Open a voice call to load\nyour available models.",full_page_?362:236);lv_label_set_long_mode(l,LV_LABEL_LONG_WRAP);}
        for(size_t i=0;i<info_.models.size();++i){
            Row(info_.models[i].c_str(),nullptr,
                [this,i]{Emit(Action::SelectModel,static_cast<int>(i));Show(model_return_);},
                info_.model==info_.models[i]);
        }break;
    case Page::Reasoning: {
        Header("Reasoning",Page::CodexSettings);Column();
        const char* levels[]={"Default","Low","Medium","High","XHigh","Max","Ultra"};
        for(const auto& level:levels){
            const bool current=info_.reasoning==level;
            Row(level,nullptr,[this,level]{
                info_.reasoning=level;
                Emit(Action::SelectReasoning,0,level);
                Show(Page::CodexSettings);
            },current);
        }
        break;
    }
    default:break;
    }
    UpdateNotice();
}
void WatchUi::UpdateNotice() {
    if (notice_) { lv_obj_delete(notice_); notice_ = nullptr; }
    // A notice can arrive long after the page was built, so the list is
    // resized here too - not only when Column() first lays it out.
    if (column_ != nullptr && dot_style_ && lv_obj_get_y(column_) == (full_page_?130:100))
        lv_obj_set_height(column_, info_.notice.empty() ? (full_page_?372:212)
                                                         : (full_page_?238:150));
    // The keyboard's Cancel/Submit row occupies this banner's normal bottom
    // position. Keep that action row usable while text input is open; the
    // notice is shown again when the keyboard returns to its caller page.
    if (!info_.notice.empty() && page_ != Page::Voice && page_ != Page::Keyboard) {
        if(full_page_){
            notice_=Box(shell_,24,380,362,90,0x000000,8);
            lv_obj_set_style_border_width(notice_,1,0);
            lv_obj_set_style_border_color(notice_,lv_color_hex(0x5A3F10),0);
            auto message=Label(notice_,info_.notice.c_str(),342);
            lv_obj_set_style_text_font(message,font_,0);
            lv_obj_set_style_text_color(message,lv_color_hex(0xF5A524),0);
            lv_label_set_long_mode(message,LV_LABEL_LONG_WRAP);
            lv_obj_set_pos(message,10,10);
            lv_obj_update_layout(message);
            const int height=std::min(118,std::max(58,static_cast<int>(lv_obj_get_height(message))+20));
            lv_obj_set_height(notice_,height);
            lv_obj_set_y(notice_,470-height);
            return;
        }
        // It used to be a navy pill in the old typeface, dropped in the middle
        // of the screen where it covered a row of whatever list was open. Now
        // it is a strip along the bottom, in the page's own language.
        dm_style_t st={full_page_?4:2,full_page_?3:1,1,0xF5A524u,0x101010u};
        const int max_w = full_page_?362:248, room = max_w - 16;
        std::string first = info_.notice, second;
        if (dm_width(first.c_str(), &st) > room) {
            // Break at the last space that fits. A banner cut mid-word loses
            // the half that says what to do about it.
            size_t cut = first.size();
            while (cut > 0 && dm_width(first.substr(0, cut).c_str(), &st) > room) --cut;
            const size_t space = first.rfind(' ', cut);
            if (space != std::string::npos && space > 0) cut = space;
            second = first.substr(cut);
            while (!second.empty() && second.front() == ' ') second.erase(second.begin());
            first = first.substr(0, cut);
            second = Fit(second.c_str(), &st, room);
        }
        const int line_h = DM_H * st.pitch;
        const int box_h = second.empty() ? line_h + 14 : line_h * 2 + 18;
        const int box_w = std::min(max_w,
            std::max(dm_width(first.c_str(), &st), dm_width(second.c_str(), &st)) + 16);
        notice_ = Box(shell_, (full_page_?205:kCenter) - box_w / 2,
                      (full_page_?460:306) - box_h, box_w, box_h, 0x000000, 6);
        lv_obj_set_style_border_width(notice_, 1, 0);
        lv_obj_set_style_border_color(notice_, lv_color_hex(0x5A3F10), 0);
        dm_text_center(notice_, box_w / 2, 7, first.c_str(), &st);
        if (!second.empty()) dm_text_center(notice_, box_w / 2, 11 + line_h, second.c_str(), &st);
    }
}
void WatchUi::ShowSliderValue(int percent) {
    if (value_ != nullptr) lv_obj_delete(value_);
    if(full_page_){
        value_=Label(shell_,(std::to_string(percent)+"%").c_str(),362);
        lv_obj_set_style_text_align(value_,LV_TEXT_ALIGN_CENTER,0);
        lv_obj_set_style_text_color(value_,lv_color_hex(kAmoledText),0);
        lv_obj_set_pos(value_,24,170);
        return;
    }
    dm_style_t st = {full_page_?7:4, full_page_?6:3, 1, 0xFFFFFFu, 0x101010u};
    value_ = dm_text_center(shell_, full_page_?205:kCenter,full_page_?172:128,
                            (std::to_string(percent) + "%").c_str(), &st);
}
// Brightness used to carry its own copy of this, 40px higher up the screen and
// without the hint line, so two sibling pages never matched. One slider now.
void WatchUi::Slider(bool brightness) {
    const int initial=brightness?info_.brightness:info_.volume;
    ShowSliderValue(initial);
    auto slider=lv_slider_create(shell_);
    lv_obj_set_size(slider,full_page_?302:216,full_page_?20:14);
    lv_obj_set_pos(slider,full_page_?54:72,full_page_?258:186);
    lv_obj_set_ext_click_area(slider,20);lv_slider_set_range(slider,brightness?5:0,100);
    lv_slider_set_value(slider,initial,LV_ANIM_OFF);
    // The stock slider is a blue knob on a teal bar on a navy track - three
    // colours, none of them ours. Dark trough, one accent fill, white knob.
    lv_obj_set_style_bg_color(slider,lv_color_hex(0x1A1A1A),LV_PART_MAIN);
    lv_obj_set_style_bg_opa(slider,LV_OPA_COVER,LV_PART_MAIN);
    lv_obj_set_style_radius(slider,7,LV_PART_MAIN);
    lv_obj_set_style_bg_color(slider,lv_color_hex(full_page_?Palette(info_.ui_theme).accent:kAccent),LV_PART_INDICATOR);
    lv_obj_set_style_radius(slider,7,LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(slider,lv_color_white(),LV_PART_KNOB);
    lv_obj_set_style_pad_all(slider,5,LV_PART_KNOB);
    lv_obj_add_event_cb(slider,[](lv_event_t* e){
        auto self=static_cast<WatchUi*>(lv_event_get_user_data(e));
        int value=lv_slider_get_value(static_cast<lv_obj_t*>(lv_event_get_target(e)));
        self->ShowSliderValue(value);
    },LV_EVENT_VALUE_CHANGED,this);
    lv_obj_add_event_cb(slider,[](lv_event_t* e){
        auto self=static_cast<WatchUi*>(lv_event_get_user_data(e));
        int v=lv_slider_get_value(static_cast<lv_obj_t*>(lv_event_get_target(e)));
        bool b=self->page_==Page::Brightness;(b?self->info_.brightness:self->info_.volume)=v;
        self->Emit(b?Action::Brightness:Action::Volume,v);
    },LV_EVENT_RELEASED,this);
    if(full_page_){
        auto hint=Label(shell_,"Release to save",362);
        lv_obj_set_style_text_align(hint,LV_TEXT_ALIGN_CENTER,0);
        lv_obj_set_style_text_color(hint,lv_color_hex(kAmoledMuted),0);
        lv_obj_set_pos(hint,24,298);
        return;
    }
    dm_style_t hint={full_page_?4:2,full_page_?3:1,1,
                     full_page_?0xC7C7CCu:0x5A5A5Fu,0x101010u};
    dm_text_center(shell_,full_page_?205:kCenter,
                   full_page_?305:(brightness?216:222),"RELEASE TO SAVE",&hint);
}
void WatchUi::DrawClockFace() {
    if (clock_ != nullptr) { lv_obj_delete(clock_); clock_ = nullptr; }
    if (date_ != nullptr) { lv_obj_delete(date_); date_ = nullptr; }
    if(full_page_){
        clock_=Label(shell_,time_.c_str(),362);
        lv_obj_set_style_text_align(clock_,LV_TEXT_ALIGN_CENTER,0);
        lv_obj_set_style_text_color(clock_,lv_color_hex(kAmoledText),0);
        lv_obj_set_pos(clock_,24,198);
        date_=Label(shell_,date_text_.c_str(),362);
        lv_obj_set_style_text_align(date_,LV_TEXT_ALIGN_CENTER,0);
        lv_obj_set_style_text_color(date_,lv_color_hex(Palette(info_.ui_theme).accent),0);
        lv_obj_set_pos(date_,24,277);
        return;
    }
    dm_style_t big = {full_page_?8:6, full_page_?7:5, 1, 0xFFFFFFu, 0x101010u};
    clock_ = dm_text_center(shell_, full_page_?205:kCenter,full_page_?205:140,time_.c_str(),&big);
    dm_style_t small = {full_page_?4:2, full_page_?3:1, 1, 0xF5A524u, 0x101010u};
    date_ = dm_text_center(shell_, full_page_?205:kCenter,full_page_?285:214,date_text_.c_str(),&small);
}
void WatchUi::SetInfo(const Info& info) {
    const bool theme_changed=info_.ui_theme!=info.ui_theme;
    bool wifi_changed=info_.networks!=info.networks||info_.network!=info.network||info_.wifi_status!=info.wifi_status;
    bool models_changed=info_.models!=info.models;
    bool chats_changed=info_.chats!=info.chats||info_.chat_folders!=info.chat_folders||
                       info_.chat!=info.chat||info_.temporary_chat!=info.temporary_chat;
    // Captions live on the ChatGPT page, not the Chats page, so they need
    // their own trigger - folded in with the chats it would only ever have
    // redrawn a page the row is not on.
    const bool captions_changed=info_.captions!=info.captions;
    bool sleep_changed=info_.sleep_seconds!=info.sleep_seconds;
    bool notice_changed=info_.notice!=info.notice;
    info_=info;
    if((full_page_&&theme_changed)
       ||(page_==Page::Wifi&&wifi_changed)
       ||(page_==Page::Models&&models_changed)
       ||(page_==Page::Chats&&chats_changed)
       ||(page_==Page::Sleep&&sleep_changed)
       ||(page_==Page::Brightness&&sleep_changed)
       ||(page_==Page::CodexSettings&&captions_changed)) Show(page_);
    else if (notice_changed) UpdateNotice();
}
void WatchUi::Tick(const char* clock,const char* date){
    time_=clock;date_text_=date;
    // The Clock page draws into canvases and has to be repainted; Home still
    // uses a plain label, which can just be re-lettered.
    if(page_==Page::Clock){DrawClockFace();return;}
    if(clock_)lv_label_set_text(clock_,clock);
    if(date_)lv_label_set_text(date_,date);
}
void WatchUi::SetCallActive(bool active){
    if(active&&!call_active_&&page_==Page::Home)Show(Page::Voice);
    call_active_=active;
}
void WatchUi::GoHome(){
    // Ending the call first is not optional on the call screen: the hang-up
    // button only exists there, so leaving it on screen would strand the call
    // with nothing to stop it.
    if(page_==Page::Voice) Emit(Action::EndCall);
    Show(Page::Home);
    Emit(Action::Refresh);
}
void WatchUi::ChooseNetwork(const std::string& ssid){
    join_ssid_=ssid;
    if(std::find(info_.saved_networks.begin(),info_.saved_networks.end(),ssid)!=info_.saved_networks.end()){
        Emit(Action::JoinWifi,1,ssid);Show(Page::Wifi);return;
    }
    OpenKeyboard(FieldKind::Password,"Wi-Fi password","",[this,ssid](std::string password){
        Emit(Action::JoinWifi,0,ssid,password);
        std::fill(password.begin(), password.end(), '\0');
        Show(Page::Wifi);
    });
}
void WatchUi::ShowKeyboardError(const char* text){
    if(!error_){
        // Error sits between the key area and the action buttons; it never
        // appears over a key, so an invalid input never obscures what the
        // user already typed.
        error_=Label(shell_,"",full_page_?362:220);
        lv_obj_set_style_text_align(error_,LV_TEXT_ALIGN_CENTER,0);
        lv_label_set_long_mode(error_,LV_LABEL_LONG_WRAP);
        lv_obj_set_style_text_color(error_,lv_color_hex(0xF25C54),0);
        lv_obj_set_pos(error_,full_page_?24:70,full_page_?374:250);
    }
    lv_label_set_text(error_,text);
}
void WatchUi::ClearKeyboardError(){
    if(error_){lv_label_set_text(error_,"");}
}
void WatchUi::OpenKeyboard(FieldKind kind,const std::string& title,const std::string& initial,
                           std::function<void(const std::string&)> done){
    keyboard_kind_=kind;
    if (page_ != Page::Keyboard) keyboard_return_=page_;
    Show(Page::Keyboard);
    keyboard_done_=std::move(done);
    key_page_=0;uppercase_=false;
    auto l=Label(shell_,title.c_str(),full_page_?362:220);
    lv_obj_set_style_text_color(l,lv_color_white(),0);
    lv_obj_set_style_text_align(l,LV_TEXT_ALIGN_CENTER,0);
    if(full_page_)lv_obj_set_style_text_font(l,&font_noto_sans_basic_30_4,0);
    lv_obj_set_pos(l,full_page_?24:70,full_page_?44:34);
    field_=lv_textarea_create(shell_);
    lv_obj_set_pos(field_,full_page_?24:70,full_page_?100:62);
    lv_obj_set_size(field_,full_page_?362:220,full_page_?54:34);
    lv_obj_set_style_pad_all(field_,5,0);
    lv_obj_set_style_bg_color(field_,lv_color_hex(full_page_?Palette(info_.ui_theme).card:0x141414),0);
    lv_obj_set_style_text_color(field_,lv_color_white(),0);
    if(full_page_)lv_obj_set_style_text_font(field_,&font_noto_sans_basic_30_4,0);
    lv_obj_set_style_border_color(field_,lv_color_hex(full_page_?Palette(info_.ui_theme).accent:kAccent),0);
    lv_obj_set_style_border_width(field_,1,0);
    lv_textarea_set_one_line(field_,true);
    const bool secret = kind == FieldKind::Password;
    const int max_len = kind == FieldKind::Password ? 64 : 32;
    lv_textarea_set_max_length(field_,max_len);
    lv_textarea_set_password_mode(field_,secret);
    if(secret)lv_textarea_set_password_show_time(field_,0);
    lv_textarea_set_text(field_,initial.c_str());
    // Keys container spans the chord-safe key area only. The function row sits
    // at the bottom of the container, and Cancel/Submit live on shell_ below.
    keys_=Box(shell_,full_page_?24:0,full_page_?165:100,
              full_page_?362:360,full_page_?196:156,0,0);
    lv_obj_set_style_bg_opa(keys_,LV_OPA_TRANSP,0);
    KeyboardKeys();
    const char* submit_label = kind == FieldKind::Ssid ? "Next"
                            : kind == FieldKind::Password ? "Join"
                            : "Submit";
    Button(shell_,full_page_?55:90,full_page_?420:278,full_page_?140:84,full_page_?58:44,
           "Cancel",nullptr,[this]{
        if(field_){ lv_textarea_set_text(field_,""); }
        ClearKeyboardError();
        Show(keyboard_return_);
    });
    auto submit=Button(shell_,full_page_?215:186,full_page_?420:278,
                       full_page_?140:84,full_page_?58:44,submit_label,nullptr,[this]{
        if(!field_) return;
        std::string value=lv_textarea_get_text(field_);
        // Validate per FieldKind. On invalid: show inline error and stay on
        // the keyboard page. On valid: hand off to the caller; the caller
        // owns navigation (ChooseNetwork, JoinWifi, etc.).
        if(keyboard_kind_==FieldKind::Ssid){
            if(value.empty()||value.size()>32||value.find('\0')!=std::string::npos){
                ShowKeyboardError("Enter 1-32 characters");
                return;
            }
        } else if(keyboard_kind_==FieldKind::Password){
            const bool empty_open=value.empty();
            const bool psk63=value.size()>=8&&value.size()<=63
                &&std::all_of(value.begin(),value.end(),IsPrintableAscii);
            const bool hex64=value.size()==64
                &&std::all_of(value.begin(),value.end(),IsHex);
            if(!(empty_open||psk63||hex64)){
                ShowKeyboardError("Password must be 8-63 chars or 64 hex");
                return;
            }
        }
        ClearKeyboardError();
        auto done=keyboard_done_;
        lv_textarea_set_text(field_,"");
        if(done) done(value);
        std::fill(value.begin(), value.end(), '\0');
    },full_page_?Palette(info_.ui_theme).accent:kAccent);
    if(full_page_)
        lv_obj_set_style_text_color(lv_obj_get_child(submit,0),lv_color_hex(0x071015),0);
}
void WatchUi::KeyboardKeys(){
    lv_obj_clean(keys_);
    const char* letters[]={"qwertyuiop","asdfghjkl","zxcvbnm"};
    const char* symbols[]={"1234567890","@#$%&-+()","!\"':;?/\\"};
    const char* extra[]={"[]{}<>_=~","`^*.,|", "0123456789"};
    if(full_page_){
        for(int row=0;row<3;++row){
            std::string chars=key_page_==0?letters[row]:key_page_==1?symbols[row]:extra[row];
            if(uppercase_&&key_page_==0)
                for(char& c:chars)c=static_cast<char>(c-'a'+'A');
            constexpr int key_w=32,gap=4;
            const int count=static_cast<int>(chars.size());
            int x=(362-(key_w*count+gap*(count-1)))/2;
            for(char c:chars){
                std::string key(1,c);
                Button(keys_,x,row*52,key_w,44,key.c_str(),nullptr,
                       [this,key]{if(field_)lv_textarea_add_text(field_,key.c_str());},
                       Palette(info_.ui_theme).card);
                x+=key_w+gap;
            }
        }
        Button(keys_,0,156,68,38,key_page_==0?"123":key_page_==1?"#+=":"abc",nullptr,
               [this]{key_page_=(key_page_+1)%3;KeyboardKeys();},Palette(info_.ui_theme).card);
        Button(keys_,74,156,54,38,"Aa",nullptr,
               [this]{uppercase_=!uppercase_;key_page_=0;KeyboardKeys();},Palette(info_.ui_theme).card);
        Button(keys_,134,156,128,38,"space",nullptr,
               [this]{if(field_)lv_textarea_add_text(field_," ");},Palette(info_.ui_theme).card);
        Button(keys_,268,156,94,38,"Del",nullptr,
               [this]{if(field_)lv_textarea_delete_char(field_);},Palette(info_.ui_theme).card);
        return;
    }
    for(int row=0;row<3;++row){
        std::string chars=key_page_==0?letters[row]:key_page_==1?symbols[row]:extra[row];
        if(uppercase_&&key_page_==0)for(char& c:chars)c=static_cast<char>(c-'a'+'A');
        const int y_abs=104+40*row,h=32;
        int dy=std::max(std::abs(y_abs-180),std::abs(y_abs+h-180));
        int avail=static_cast<int>(2*std::sqrt(176*176-dy*dy))-12;
        int w=(avail-(static_cast<int>(chars.size())-1)*4)/static_cast<int>(chars.size());
        int x=180-(w*static_cast<int>(chars.size())+4*(static_cast<int>(chars.size())-1))/2;
        for(char c:chars){
            std::string key(1,c);
            Button(keys_,x,y_abs-92,w,h,key.c_str(),nullptr,
                   [this,key]{ if(field_) lv_textarea_add_text(field_,key.c_str()); },
                   0x1A1A1A);
            x+=w+4;
        }
    }
    // Function row at relative y=124 (absolute y=224), h=28 — sits between
    // the last key row (y_abs=176..208) and Cancel/Submit (y_abs=278).
    Button(keys_,26,124,66,28,key_page_==0?"123":key_page_==1?"#+=":"abc",nullptr,
           [this]{ key_page_=(key_page_+1)%3; KeyboardKeys(); });
    Button(keys_,98,124,48,28,"Aa",nullptr,
           [this]{ uppercase_=!uppercase_; key_page_=0; KeyboardKeys(); });
    Button(keys_,152,124,98,28,"space",nullptr,
           [this]{ if(field_) lv_textarea_add_text(field_," "); });
    Button(keys_,256,124,76,28,"Del",nullptr,
           [this]{ if(field_) lv_textarea_delete_char(field_); });
}
