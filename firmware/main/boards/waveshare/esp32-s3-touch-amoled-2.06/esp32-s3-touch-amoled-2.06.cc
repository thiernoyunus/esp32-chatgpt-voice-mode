// Adapted from 78/xiaozhi-esp32's Waveshare 2.06 board (MIT license).
// Pins and panel commands are board-specific; Codex Voice and the watch UI
// remain in the shared application and display layers.
#include "wifi_board.h"
#include "display/lcd_display.h"
#include "esp_lcd_sh8601.h"

#include "codecs/box_audio_codec.h"
#include "application.h"
#include "button.h"
#include "config.h"
#include "axp2101.h"

#include <esp_log.h>
#include <esp_lcd_panel_vendor.h>
#include <driver/i2c_master.h>
#include <driver/spi_master.h>

#include <esp_lcd_touch_ft5x06.h>
#include <esp_lvgl_port.h>
#include <esp_pm.h>
#include <esp_sleep.h>
#include <lvgl.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <atomic>

#define TAG "WaveshareEsp32s3TouchAMOLED2inch06"

class Pmic : public Axp2101 {
public:
    Pmic(i2c_master_bus_handle_t i2c_bus, uint8_t addr) : Axp2101(i2c_bus, addr) {
        WriteReg(0x22, 0b110); // PWRON > OFFLEVEL as POWEROFF Source enable
        WriteReg(0x27, 0x10);  // hold 4s to power off

        // Disable All DCs but DC1
        WriteReg(0x80, 0x01);
        // Disable All LDOs
        WriteReg(0x90, 0x00);
        WriteReg(0x91, 0x00);

        // Set DC1 to 3.3V
        WriteReg(0x82, (3300 - 1500) / 100);

        // Set ALDO1 to 3.3V
        WriteReg(0x92, (3300 - 500) / 100);
        WriteReg(0x93, (3300 - 500) / 100);

        // Enable ALDO1(MIC)
        WriteReg(0x90, 0x03);

        // Match the upstream settings for this watch's small battery.
        WriteReg(0x64, 0x02); // 4.1 V charge end voltage
        WriteReg(0x61, 0x02); // 50 mA precharge
        WriteReg(0x62, 0x0A); // 400 mA charging
        WriteReg(0x63, 0x01); // 25 mA termination
    }
};

#define LCD_OPCODE_WRITE_CMD (0x02ULL)

static const sh8601_lcd_init_cmd_t vendor_specific_init[] = {
    // set display to qspi mode
    {0x11, (uint8_t []){0x00}, 0, 120},
    {0xC4, (uint8_t []){0x80}, 1, 0},
    {0x44, (uint8_t []){0x01, 0xD1}, 2, 0},
    {0x35, (uint8_t []){0x00}, 1, 0},
    {0x53, (uint8_t []){0x20}, 1, 10},
    {0x63, (uint8_t []){0xFF}, 1, 10},
    {0x51, (uint8_t []){0x00}, 1, 10},
    {0x2A, (uint8_t []){0x00,0x16,0x01,0xAF}, 4, 0},
    {0x2B, (uint8_t []){0x00,0x00,0x01,0xF5}, 4, 0},
    {0x29, (uint8_t []){0x00}, 0, 10},
    {0x51, (uint8_t []){0xFF}, 1, 0},
};

class CustomLcdDisplay : public SpiLcdDisplay {
    TaskHandle_t lvgl_task_ = nullptr;
public:
    static void rounder_event_cb(lv_event_t* e) {
        lv_area_t* area = (lv_area_t* )lv_event_get_param(e);
        const uint16_t x1 = area->x1;
        const uint16_t x2 = area->x2;
        const uint16_t y1 = area->y1;
        const uint16_t y2 = area->y2;

        // round the start of coordinate down to the nearest 2M number
        area->x1 = (x1 >> 1) << 1;
        area->y1 = (y1 >> 1) << 1;
        // round the end of coordinate up to the nearest 2N+1 number
        area->x2 = ((x2 >> 1) << 1) + 1;
        area->y2 = ((y2 >> 1) << 1) + 1;
    }

    CustomLcdDisplay(esp_lcd_panel_io_handle_t io_handle,
                     esp_lcd_panel_handle_t panel_handle,
                     int width,
                     int height,
                     int offset_x,
                     int offset_y,
                     bool mirror_x,
                     bool mirror_y,
                     bool swap_xy)
        : SpiLcdDisplay(io_handle, panel_handle,
                        width, height, offset_x, offset_y, mirror_x, mirror_y, swap_xy) {
    }

    virtual void SetupUI() override {
        SpiLcdDisplay::SetupUI();
        lvgl_task_ = xTaskGetHandle("taskLVGL");
        if (lvgl_task_ == nullptr) {
            ESP_LOGW(TAG, "LVGL task unavailable for display sleep");
        }

        DisplayLockGuard lock(this);
        lv_obj_set_style_pad_left(status_bar_, 36, 0);
        lv_obj_set_style_pad_right(status_bar_, 36, 0);
        lv_display_add_event_cb(display_, rounder_event_cb, LV_EVENT_INVALIDATE_AREA, NULL);
    }

    void SetPowerSaveMode(bool on) override {
        if (!on) {
            esp_pm_config_t pm_config = {
                .max_freq_mhz = 240,
                .min_freq_mhz = 240,
                .light_sleep_enable = false,
            };
            ESP_ERROR_CHECK(esp_pm_configure(&pm_config));
            ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel_, true));
            if (lvgl_task_ != nullptr) vTaskResume(lvgl_task_);
            ESP_ERROR_CHECK(lvgl_port_resume());
        }
        SpiLcdDisplay::SetPowerSaveMode(on);
        if (on) {
            {
                // Hold the UI lock until the task is suspended, so it cannot
                // stop while owning that lock.
                DisplayLockGuard lock(this);
                ESP_ERROR_CHECK(lvgl_port_stop());
                if (lvgl_task_ != nullptr) vTaskSuspend(lvgl_task_);
            }
            ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel_, false));
            esp_pm_config_t pm_config = {
                .max_freq_mhz = 240,
                .min_freq_mhz = 40,
                .light_sleep_enable = true,
            };
            ESP_ERROR_CHECK(esp_pm_configure(&pm_config));
        } else {
            UpdateStatusBar(true);
        }
    }
};

class CustomBacklight : public Backlight {
public:
    CustomBacklight(esp_lcd_panel_io_handle_t panel_io) : Backlight(), panel_io_(panel_io) {}

protected:
    esp_lcd_panel_io_handle_t panel_io_;

    void SetBrightnessImpl(uint8_t brightness) override {
        auto display = Board::GetInstance().GetDisplay();
        DisplayLockGuard lock(display);
        uint8_t data[1] = {static_cast<uint8_t>(255 * brightness / 100)};
        int lcd_cmd = 0x51;
        lcd_cmd &= 0xff;
        lcd_cmd <<= 8;
        lcd_cmd |= LCD_OPCODE_WRITE_CMD << 24;
        esp_lcd_panel_io_tx_param(panel_io_, lcd_cmd, &data, sizeof(data));
    }
};

// Read by TouchInterrupt, so it lives in internal RAM (see there).
static DRAM_ATTR TaskHandle_t s_touch_task_for_isr = nullptr;

// The button component installs the GPIO interrupt service as IRAM-safe,
// so this runs even while flash is busy (saving settings, reading the mascot's
// pictures). Then flash *and PSRAM* are out of reach, so it touches only
// IRAM code and internal-RAM data: not `tp` or this board object, which
// live in PSRAM. Either crashed with "Cache disabled but cached memory
// region accessed".
static void IRAM_ATTR TouchInterrupt(esp_lcd_touch_handle_t) {
    if (s_touch_task_for_isr != nullptr) {
        BaseType_t higher_priority_woken = pdFALSE;
        vTaskNotifyGiveFromISR(s_touch_task_for_isr, &higher_priority_woken);
        if (higher_priority_woken) portYIELD_FROM_ISR();
    }
}
// (A free function: IRAM_ATTR on a function defined inside the class fails to link.)

class WaveshareEsp32s3TouchAMOLED2inch06 : public WifiBoard {
private:
    i2c_master_bus_handle_t i2c_bus_;
    Pmic* pmic_ = nullptr;
    PowerSaveButton boot_button_;
    CustomLcdDisplay* display_;
    CustomBacklight* backlight_;
    esp_lcd_touch_handle_t touch_handle_ = nullptr;
    TaskHandle_t touch_task_handle_ = nullptr;
    std::atomic<bool> touch_interrupt_ready_{false};

    void InitializeCodecI2c() {
        i2c_master_bus_config_t i2c_bus_cfg = {
            .i2c_port = I2C_NUM_0,
            .sda_io_num = AUDIO_CODEC_I2C_SDA_PIN,
            .scl_io_num = AUDIO_CODEC_I2C_SCL_PIN,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .flags = {
                .enable_internal_pullup = 1,
            },
        };
        ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus_));
    }

    void InitializeAxp2101() {
        ESP_LOGI(TAG, "Init AXP2101");
        pmic_ = new Pmic(i2c_bus_, 0x34);
    }

    void InitializeSpi() {
        spi_bus_config_t buscfg = {};
        buscfg.sclk_io_num = EXAMPLE_PIN_NUM_LCD_PCLK;
        buscfg.data0_io_num = EXAMPLE_PIN_NUM_LCD_DATA0;
        buscfg.data1_io_num = EXAMPLE_PIN_NUM_LCD_DATA1;
        buscfg.data2_io_num = EXAMPLE_PIN_NUM_LCD_DATA2;
        buscfg.data3_io_num = EXAMPLE_PIN_NUM_LCD_DATA3;
        buscfg.max_transfer_sz = DISPLAY_WIDTH*  DISPLAY_HEIGHT*  sizeof(uint16_t);
        buscfg.flags = SPICOMMON_BUSFLAG_QUAD;
        ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_CH_AUTO));
    }

    void InitializeButtons() {
        boot_button_.OnClick([this]() {
            auto& app = Application::GetInstance();
            if (app.GetDeviceState() == kDeviceStateStarting) {
                EnterWifiConfigMode();
                return;
            }
            app.ToggleChatState();
        });

        boot_button_.OnMultipleClick([this]() { EnterWifiConfigMode(); }, 3);
    }

    void InitializeSH8601Display() {
        esp_lcd_panel_io_handle_t panel_io = nullptr;
        esp_lcd_panel_handle_t panel = nullptr;

        ESP_LOGD(TAG, "Install panel IO");
        esp_lcd_panel_io_spi_config_t io_config = {};
        io_config.cs_gpio_num = EXAMPLE_PIN_NUM_LCD_CS;
        io_config.dc_gpio_num = GPIO_NUM_NC;
        io_config.spi_mode = 0;
        io_config.pclk_hz = 40 * 1000 * 1000;
        io_config.trans_queue_depth = 10;
        io_config.lcd_cmd_bits = 32;
        io_config.lcd_param_bits = 8;
        io_config.flags.quad_mode = true;
        ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(SPI2_HOST, &io_config, &panel_io));

        ESP_LOGD(TAG, "Install LCD driver");
        const sh8601_vendor_config_t vendor_config = {
            .init_cmds = &vendor_specific_init[0],
            .init_cmds_size = sizeof(vendor_specific_init) / sizeof(sh8601_lcd_init_cmd_t),
            .flags = {
                .use_qspi_interface = 1,
            }};

        esp_lcd_panel_dev_config_t panel_config = {};
        panel_config.reset_gpio_num = EXAMPLE_PIN_NUM_LCD_RST;
        panel_config.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
        panel_config.bits_per_pixel = 16;
        panel_config.vendor_config = (void* )&vendor_config;
        ESP_ERROR_CHECK(esp_lcd_new_panel_sh8601(panel_io, &panel_config, &panel));
        esp_lcd_panel_set_gap(panel, 0x16, 0);
        esp_lcd_panel_reset(panel);
        esp_lcd_panel_init(panel);
        esp_lcd_panel_invert_color(panel, false);
        esp_lcd_panel_mirror(panel, DISPLAY_MIRROR_X, DISPLAY_MIRROR_Y);
        esp_lcd_panel_disp_on_off(panel, true);
        display_ = new CustomLcdDisplay(panel_io, panel,
                                        DISPLAY_WIDTH, DISPLAY_HEIGHT, DISPLAY_OFFSET_X, DISPLAY_OFFSET_Y, DISPLAY_MIRROR_X, DISPLAY_MIRROR_Y, DISPLAY_SWAP_XY);
        backlight_ = new CustomBacklight(panel_io);
        backlight_->RestoreBrightness();
    }

    void InitializeTouch() {
        esp_lcd_touch_config_t tp_cfg = {
            .x_max = DISPLAY_WIDTH - 1,
            .y_max = DISPLAY_HEIGHT - 1,
            .rst_gpio_num = GPIO_NUM_9,
            .int_gpio_num = GPIO_NUM_38,
            .levels = {
                .reset = 0,
                .interrupt = 0,
            },
            .flags = {
                .swap_xy = 0,
                .mirror_x = 0,
                .mirror_y = 0,
            },
        };
        esp_lcd_panel_io_i2c_config_t io_cfg = {};
        io_cfg.dev_addr = ESP_LCD_TOUCH_IO_I2C_FT5x06_ADDRESS;
        io_cfg.scl_speed_hz = 400000;
        io_cfg.control_phase_bytes = 1;
        io_cfg.lcd_cmd_bits = 8;
        io_cfg.lcd_param_bits = 0;
        io_cfg.flags.disable_control_phase = 1;

        esp_lcd_panel_io_handle_t touch_io = nullptr;
        auto err = esp_lcd_new_panel_io_i2c(i2c_bus_, &io_cfg, &touch_io);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Touch IO unavailable: %s", esp_err_to_name(err));
            return;
        }
        err = esp_lcd_touch_new_i2c_ft5x06(touch_io, &tp_cfg, &touch_handle_);
        if (err != ESP_OK || touch_handle_ == nullptr) {
            ESP_LOGW(TAG, "Touch controller unavailable: %s", esp_err_to_name(err));
            return;
        }
        if (xTaskCreate([](void* arg) {
            static_cast<WaveshareEsp32s3TouchAMOLED2inch06*>(arg)->TouchTask();
        }, "touch_amoled", 4096, this, 3, &touch_task_handle_) != pdPASS) {
            ESP_LOGE(TAG, "Could not start touch task");
            return;
        }
        s_touch_task_for_isr = touch_task_handle_;
        err = esp_lcd_touch_register_interrupt_callback_with_data(
            touch_handle_, TouchInterrupt, this);
        touch_interrupt_ready_ = err == ESP_OK;
        if (!touch_interrupt_ready_) {
            ESP_LOGW(TAG, "Touch interrupt unavailable; using periodic check: %s", esp_err_to_name(err));
        } else {
            // A GPIO interrupt handles touches while awake; this also lets
            // the same pin wake the chip from automatic light sleep.
            err = gpio_wakeup_enable(GPIO_NUM_38, GPIO_INTR_LOW_LEVEL);
            if (err == ESP_OK) err = esp_sleep_enable_gpio_wakeup();
            if (err == ESP_OK) err = gpio_sleep_sel_dis(GPIO_NUM_38);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Touch sleep wake unavailable: %s", esp_err_to_name(err));
            }
        }
        ESP_LOGI(TAG, "Touch ready");
    }

    void TouchTask() {
        bool was_pressed = false;
        bool swallow_touch = false;
        int read_failures = 0;
        bool wake_retried = false;
        int last_x = 0;
        int last_y = 0;
        while (true) {
            // An interrupt wakes this task for a new touch. The slow check is
            // a fallback in case the controller misses an interrupt.
            if (!was_pressed && Application::GetInstance().IsScreenAsleep()) {
                ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(touch_interrupt_ready_ ? 1000 : 250));
            }
            const auto err = esp_lcd_touch_read_data(touch_handle_);
            if (err != ESP_OK) {
                if (++read_failures >= 25) {
                    // FT5x06 does not implement the generic exit-sleep call.
                    // Pulse its configured reset pin once before giving up.
                    if (!wake_retried && gpio_set_level(GPIO_NUM_9, 0) == ESP_OK) {
                        vTaskDelay(pdMS_TO_TICKS(10));
                        gpio_set_level(GPIO_NUM_9, 1);
                        wake_retried = true;
                        read_failures = 0;
                        vTaskDelay(pdMS_TO_TICKS(10));
                        continue;
                    }
                    Application::GetInstance().OnWatchAction(WatchUi::Action::EndCall, 0, "", "");
                    display_->FeedTouch(false, last_x, last_y);
                    ESP_LOGE(TAG, "Touch controller stopped responding");
                    vTaskDelete(nullptr);
                    return;
                }
                vTaskDelay(pdMS_TO_TICKS(20));
                continue;
            }
            read_failures = 0;
            wake_retried = false;
            uint16_t x = 0, y = 0;
            uint8_t point_count = 0;
            const bool pressed =
                esp_lcd_touch_get_coordinates(touch_handle_, &x, &y, nullptr, &point_count, 1)
                && point_count > 0;
            auto& app = Application::GetInstance();
            if (pressed && !was_pressed) {
                swallow_touch = app.IsScreenAsleep();
                app.Schedule([&app]() { app.NoteUserActivity(); });
            }
            display_->FeedTouch(pressed && !swallow_touch && !app.IsConfirmActive(),
                                pressed ? x : last_x, pressed ? y : last_y);
            if (app.IsConfirmActive() && was_pressed && !pressed && !swallow_touch) {
                app.OnConfirmTouchRelease(last_x - (DISPLAY_WIDTH - 360) / 2,
                                          last_y - (DISPLAY_HEIGHT - 360) / 2);
            }
            if (pressed) { last_x = x; last_y = y; }
            if (!pressed) swallow_touch = false;
            was_pressed = pressed;
            if (was_pressed || !app.IsScreenAsleep()) {
                vTaskDelay(pdMS_TO_TICKS(20));
            }
        }
    }

public:
    WaveshareEsp32s3TouchAMOLED2inch06() : boot_button_(BOOT_BUTTON_GPIO) {
        InitializeCodecI2c();
        InitializeAxp2101();
        InitializeSpi();
        InitializeSH8601Display();
        InitializeTouch();
        InitializeButtons();
    }

    virtual AudioCodec* GetAudioCodec() override {
        static BoxAudioCodec audio_codec(
            i2c_bus_, 
            AUDIO_INPUT_SAMPLE_RATE, 
            AUDIO_OUTPUT_SAMPLE_RATE,
            AUDIO_I2S_GPIO_MCLK, 
            AUDIO_I2S_GPIO_BCLK, 
            AUDIO_I2S_GPIO_WS, 
            AUDIO_I2S_GPIO_DOUT, 
            AUDIO_I2S_GPIO_DIN,
            AUDIO_CODEC_PA_PIN, 
            AUDIO_CODEC_ES8311_ADDR, 
            AUDIO_CODEC_ES7210_ADDR, 
            AUDIO_INPUT_REFERENCE,
            false);  // Open I2S only while audio is needed.
        return &audio_codec;
    }

    virtual Display* GetDisplay() override {
        return display_;
    }

    virtual Backlight* GetBacklight() override {
        return backlight_;
    }

    bool IsExternalPowerConnected() override {
        return pmic_->IsExternalPowerConnected();
    }

    virtual bool GetBatteryLevel(int &level, bool &charging, bool &discharging) override {
        charging = pmic_->IsCharging();
        discharging = pmic_->IsDischarging();
        level = pmic_->GetBatteryLevel();
        return true;
    }
};

DECLARE_BOARD(WaveshareEsp32s3TouchAMOLED2inch06);
