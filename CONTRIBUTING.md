# 参与贡献

欢迎提交问题和 Pull Request。日常交流可以使用中文，修改请围绕具体问题展开。

开发环境使用 Node.js 22 或更高版本。网易云插件的打包还需要 Windows 自带的 `tar.exe`，客户端适配以 README 中列出的版本为准。

```powershell
npm ci
npm run check
npm run test:audio
npm run build
npm run build:lab
npm run test:lab
npm run build:player
npm run build:netease
```

提交问题时，请说明插件版本、网易云完整版本号、系统版本、触发步骤、预期结果和实际现象。画面问题可以附截图，卡顿问题可以附窗口大小及「频谱设置」中的 FPS。

修改三维渲染或公共模块后，请检查网页和播放页原型。修改网易云音频接口后，请检查正常播放、暂停恢复、切歌、拖动进度条，以及收起后重新展开。运行环境中的实测结果可以写进 PR 描述。

源码按入口放在 `src/web`、`src/player`、`src/netease`，共用逻辑放在 `src/shared`。依赖通过根目录的锁文件安装，构建产物由脚本生成。

新波形先在独立的 [`waveform-lab`](waveform-lab/README.md) 中试验。它包含网页监听、演示以及绘制和音频的独立副本，构建命令为 `npm run build:lab`。样式通过效果和性能验证后，再选择性接入正式入口；试验代码不直接引用 `src/shared`。

提交的贡献按本项目的 [MIT 许可证](LICENSE) 发布。引入第三方代码时，请一并保留其许可声明并更新 [第三方组件说明](THIRD_PARTY_NOTICES.md)。
