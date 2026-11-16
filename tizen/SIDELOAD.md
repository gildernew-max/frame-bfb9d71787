# Morning Board kiosk app for The Frame Pro (Tizen web app)

The app is a full-screen Tizen TV web app that loads
https://gildernew-max.github.io/frame-bfb9d71787/ in an iframe and keeps it on screen.

- **App ID:** `FrameDash1.MorningBoard` (package `FrameDash1`). Use this for `tizen run` and Home Assistant.
- **Source:** `app/` contains `config.xml`, `index.html` and `icon.png`.
- **Unsigned package (reference only):** `dist/MorningBoard-unsigned.wgt`. The TV will refuse it. Sign it on the Mac with Dave's Samsung certificate (steps below).
- The TV in these steps is at **192.168.68.53**.

What the app does:
- Kiosk iframe, landscape, no context menu, `background-support` on, screensaver turned off through `webapis.appcommon`.
- Every minute it checks `data.json`. If the network drops, the last frame stays on screen. After about 5 failed checks it shows a quiet "Waiting for the network…" card, then reloads by itself when the connection is back. It also does a full reload every 3 hours.
- Return/Back is ignored, so the kiosk stays up. Enter or Play forces a reload. Home and Exit still leave the app, as Samsung requires.

The samsung-kiosk repo (safaia.net/alozdev/samsung-kiosk) could not be fetched on 15 Nov 2026 (TLS failure / HTTP 500). This is a minimal equivalent of its iframe mode.

---

## 1. One-time Mac setup (free)

1. **Tizen Studio CLI.** It bundles its own JDK, so no separate Java install is normally needed.
   ```bash
   cd ~/Downloads
   curl -LO https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_macos-64.bin
   chmod +x web-cli_Tizen_Studio_6.1_macos-64.bin
   ./web-cli_Tizen_Studio_6.1_macos-64.bin --accept-license ~/tizen-studio
   echo 'export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
   tizen version && sdb version
   ```
   If the installer reports a missing Java runtime, install Temurin 17 (`brew install --cask temurin@17`) and run it again. Apple-silicon Macs may also need Rosetta: `softwareupdate --install-rosetta --agree-to-license`.

2. **Samsung Certificate Extension and TV extension.** Open the Package Manager GUI:
   `open ~/tizen-studio/package-manager/package-manager.bin`. If macOS blocks it, use right-click › Open.
   On the **Extension SDK** tab, install **Samsung Certificate Extension** and **TV Extensions** (latest). On the **Main SDK** tab, also install **Certificate Manager**, found under Tizen SDK tools. The CLI-only install does not include it. Equivalent CLI, if the extension repo is reachable:
   ```bash
   ~/tizen-studio/package-manager/package-manager-cli.bin install --accept-license cert-add-on
   ```

## 2. Put the TV in Developer Mode

1. Find the Mac's IP: `ipconfig getifaddr en0`. Use `en1` if the Mac is on Wi-Fi under a different interface.
2. On the TV, open **Apps**, then type **1 2 3 4 5** on the remote's number pad. On a remote without numbers, use the on-screen number pad.
3. Set **Developer mode: On** and enter the Mac's IP as **Host PC IP**. Choose OK, then fully restart the TV: hold Power until the Samsung logo appears.
4. Connect and read the TV's DUID:
   ```bash
   sdb connect 192.168.68.53:26101
   sdb devices                     # note the device name (serial), e.g. "QN55LS03HW..." or 192.168.68.53:26101
   sdb -s 192.168.68.53:26101 shell 0 getduid
   ```
   Certificate Manager also reads the DUID automatically from a connected TV.

## 3. Create Dave's Samsung TV certificate (one time, needs his Samsung account)

1. Open **Certificate Manager**: `open ~/tizen-studio/tools/certificate-manager/certificate-manager.app`. If that path isn't present, run `~/tizen-studio/tools/certificate-manager/certificate-manager`.
2. Click **+**, choose **Samsung**, then **TV**. Name the profile **FrameTV**.
3. **Author certificate:** create a new one with a name and password, then sign in with Dave's Samsung account when the browser opens.
4. **Distributor certificate:** create a new one with privilege **Public**. In the DUID list, make sure **the DUID from step 2** is included. Connected TVs are added automatically; otherwise paste it. Finish and sign in again if asked.
5. Keep the passwords. Back up `~/SamsungCertificate/FrameTV/`, which you need for future updates of the same app ID.

## 4. Package, install, run

Copy this folder to the Mac (for example `~/frame-tizen-kiosk/`), then:
```bash
cd ~/frame-tizen-kiosk
tizen security-profiles list                        # FrameTV should be listed (active)
tizen package -t wgt -s FrameTV -- app              # writes "app/Morning Board.wgt"
mv "app/Morning Board.wgt" MorningBoard.wgt
tizen install -n MorningBoard.wgt -t "$(sdb devices | awk 'NR==2{print $3}')"   # or: -s 192.168.68.53:26101
tizen run -p FrameDash1.MorningBoard -t "$(sdb devices | awk 'NR==2{print $3}')"
```
`-t` takes the device **name** shown in the third column of `sdb devices`. Alternatively, use `-s 192.168.68.53:26101`.
The app then appears under **Apps** on the TV as "Morning Board".

**Optional (makes it come back after power-on):** on the TV, turn on Settings › General › Smart Features › **Autorun Last App**. Leave the Morning Board app open when the TV is turned off. Also turn off Auto Protection Time and Auto Power Off, as in PLAN.md.

To update later, run the same `tizen package` / `tizen install` with the same profile. Uninstall with `tizen uninstall -p FrameDash1.MorningBoard -t <device>`.

---

## 5. Home Assistant Green: launch the app when the TV turns on

### Option A. Samsung Smart TV integration (recommended)

Add it from Settings › Devices & services › Add integration › **Samsung Smart TV**, using host `192.168.68.53`. Accept the "Allow" prompt on the TV. It talks to the TV over the websocket API on port 8002.

```yaml
# automations.yaml
- alias: "Frame TV: open Morning Board on power-on"
  trigger:
    - platform: state
      entity_id: media_player.samsung_frame_pro      # your TV entity
      to: "on"
  action:
    - delay: "00:00:08"                               # let Tizen finish booting
    - service: media_player.play_media
      target:
        entity_id: media_player.samsung_frame_pro
      data:
        media_content_type: app
        media_content_id: FrameDash1.MorningBoard
```
`media_player.select_source` only offers TV and HDMI inputs, so use `play_media` with `media_content_type: app` for an installed app.

### Option B. Raw websocket `ms.channel.emit` (no integration)

The endpoint is `wss://192.168.68.53:8002/api/v2/channels/samsung.remote.control?name=<base64 name>&token=<token>`. The token comes back after the first on-TV "Allow" prompt. Send:
```json
{"method":"ms.channel.emit","params":{"event":"ed.apps.launch","to":"host",
 "data":{"appId":"FrameDash1.MorningBoard","action_type":"DEEP_LINK"}}}
```
Use `DEEP_LINK` for web apps like this one; `NATIVE_LAUNCH` is for native apps. In HA, send this from a `shell_command` or `pyscript` that uses `samsungtvws`:
`SamsungTVWS(host="192.168.68.53", port=8002, token_file="/config/samsung_token.txt").run_app("FrameDash1.MorningBoard", app_type="DEEP_LINK")`.
Trigger it the same way as option A, on the TV entity turning `on`.

A REST fallback that works on many models: `curl -X POST http://192.168.68.53:8001/api/v2/applications/FrameDash1.MorningBoard`.
