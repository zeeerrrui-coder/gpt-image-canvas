import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type {
  GenerationRecord,
  GenerationStatus,
  ImageQuality,
  OutputFormat,
  ProviderSourceId,
  StylePresetId
} from "@gpt-image-canvas/shared";

export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];

const LOCALE_STORAGE_KEY = "gpt-image-canvas.locale";

const stylePresetLabels: Record<Locale, Record<StylePresetId, string>> = {
  "zh-CN": {
    none: "无风格",
    photoreal: "真实摄影",
    product: "商业产品",
    illustration: "精致插画",
    poster: "海报视觉",
    avatar: "头像角色"
  },
  en: {
    none: "No style",
    photoreal: "Photoreal",
    product: "Commercial product",
    illustration: "Polished illustration",
    poster: "Poster visual",
    avatar: "Avatar character"
  }
};

const sizePresetLabels: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "square-1k": "方形成图 1K",
    "poster-portrait": "竖版海报",
    "poster-landscape": "横版海报",
    "story-9-16": "竖屏故事",
    "video-16-9": "视频封面",
    "wide-2k": "宽屏展示 2K",
    "portrait-2k": "高清竖图 2K",
    "square-2k": "高清方图 2K",
    "wide-4k": "宽屏展示 4K"
  },
  en: {
    "square-1k": "Square 1K",
    "poster-portrait": "Portrait poster",
    "poster-landscape": "Landscape poster",
    "story-9-16": "Story 9:16",
    "video-16-9": "Video 16:9",
    "wide-2k": "Wide display 2K",
    "portrait-2k": "Portrait 2K",
    "square-2k": "Square 2K",
    "wide-4k": "Wide display 4K"
  }
};

const qualityLabels: Record<Locale, Record<ImageQuality, string>> = {
  "zh-CN": {
    auto: "自动",
    low: "快速草稿",
    medium: "标准",
    high: "高质量"
  },
  en: {
    auto: "Auto",
    low: "Fast draft",
    medium: "Standard",
    high: "High quality"
  }
};

const outputFormatLabels: Record<OutputFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP"
};

const generationModeLabels: Record<Locale, Record<GenerationRecord["mode"], string>> = {
  "zh-CN": {
    generate: "提示词到画布",
    edit: "参考图到画布"
  },
  en: {
    generate: "Prompt to canvas",
    edit: "Reference to canvas"
  }
};

const generationStatusLabels: Record<Locale, Record<GenerationStatus, string>> = {
  "zh-CN": {
    pending: "等待中",
    running: "生成中",
    succeeded: "已完成",
    partial: "部分完成",
    failed: "失败",
    cancelled: "已取消"
  },
  en: {
    pending: "Pending",
    running: "Generating",
    succeeded: "Complete",
    partial: "Partial",
    failed: "Failed",
    cancelled: "Cancelled"
  }
};

const providerSourceLabels: Record<Locale, Record<ProviderSourceId, string>> = {
  "zh-CN": {
    "env-openai": "环境 OpenAI",
    "local-openai": "本地 OpenAI",
    codex: "Codex"
  },
  en: {
    "env-openai": "Environment OpenAI",
    "local-openai": "Local OpenAI",
    codex: "Codex"
  }
};

const providerSourceDescriptions: Record<Locale, Record<ProviderSourceId, string>> = {
  "zh-CN": {
    "env-openai": "只读读取 .env 或运行时环境变量",
    "local-openai": "保存在本机 SQLite 的 OpenAI 兼容配置",
    codex: "使用本机 Codex 授权会话"
  },
  en: {
    "env-openai": "Read-only .env or runtime environment variables",
    "local-openai": "OpenAI-compatible settings stored in local SQLite",
    codex: "Use the local Codex authorized session"
  }
};

const commonApiErrorMessages: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    empty_json: "请求体不能为空，必须是有效的 JSON。",
    internal_error: "服务器内部错误。",
    invalid_json: "请求体必须是有效的 JSON。",
    invalid_prompt: "请输入有效的提示词。",
    invalid_request: "请求内容无效。",
    invalid_size: "请提供有效的图像尺寸。",
    insufficient_credits: "积分不足，请联系管理员发放积分。",
    missing_api_key: "服务器缺少可用的 OpenAI API Key。",
    not_found: "找不到请求的资源。",
    unauthorized: "请先登录。",
    forbidden: "需要管理员权限。",
    auth_error: "账号操作失败。",
    credit_error: "积分操作失败。",
    provider_config_error: "服务配置保存失败。",
    storage_config_error: "云存储配置保存失败。",
    upstream_failure: "上游图像服务请求失败，请稍后重试。",
    unsupported_media_type: "请求 Content-Type 必须是 application/json。",
    unsupported_provider_behavior: "图像服务返回了不支持的结果。"
  },
  en: {
    empty_json: "The request body cannot be empty and must be valid JSON.",
    internal_error: "Internal server error.",
    invalid_json: "The request body must be valid JSON.",
    invalid_prompt: "Enter a valid prompt.",
    invalid_request: "The request is invalid.",
    invalid_size: "Provide a valid image size.",
    insufficient_credits: "Not enough credits. Ask the administrator to grant credits.",
    missing_api_key: "The server does not have an available OpenAI API key.",
    not_found: "The requested resource was not found.",
    unauthorized: "Sign in first.",
    forbidden: "Administrator permission is required.",
    auth_error: "Account action failed.",
    credit_error: "Credit action failed.",
    provider_config_error: "Provider settings could not be saved.",
    storage_config_error: "Cloud storage settings could not be saved.",
    upstream_failure: "The upstream image service request failed. Try again later.",
    unsupported_media_type: "The request Content-Type must be application/json.",
    unsupported_provider_behavior: "The image service returned an unsupported result."
  }
};

const zhMessages = {
  appCanvasAria: "gpt-image-canvas 创作画布",
  appGalleryLoading: "正在载入画廊...",
  appTagline: "本地 AI 图像画布",
  authStatusLoadFailed: "无法读取图像服务登录状态。",
  autosaveFailed: "自动保存失败，当前画布已保留，请稍后继续编辑。",
  canvasLoadingTitle: "正在载入 gpt-image-canvas",
  codexCloseLogin: "关闭 Codex 登录",
  codexCodeExpires: ({ time }: { time: string }) => `代码将在 ${time} 过期。`,
  codexCopyCode: "复制代码",
  codexCreatingCode: "正在创建登录码...",
  codexLoginAuthorized: "Codex 已登录。",
  codexLoginFailedToStart: "Codex 登录无法启动。",
  codexLoginIncomplete: "Codex 登录未完成，请重新开始。",
  codexLoginPollingFailed: "Codex 登录轮询失败。",
  codexLoginSubtitle: "使用 Codex 账号授权本地生成服务。",
  codexLoginTitle: "登录 Codex",
  codexLogoutFailed: "Codex 登出失败。",
  codexOpenLoginPage: "打开登录页",
  codexPendingAuth: "等待浏览器授权完成。",
  codexRestart: "重新开始",
  commonCancel: "取消",
  commonClose: "关闭",
  commonCopy: "复制",
  commonDownload: "下载",
  commonFailed: "失败",
  commonListSeparator: "，",
  commonNotRecorded: "未记录",
  commonNotSet: "未设置",
  commonRemove: "移除",
  commonReuse: "复用",
  commonSaved: "已保存",
  commonSentenceEnd: "。",
  customSize: "自定义",
  customSizeManual: "手动输入",
  customSizeOption: "自定义尺寸",
  errorFallback: ({ status }: { status: number }) => `生成请求失败，状态 ${status}。`,
  errorHttpSuffix: ({ status }: { status: number }) => `（HTTP ${status}）`,
  galleryActionCopyPrompt: ({ excerpt }: { excerpt: string }) => `复制提示词：${excerpt}`,
  galleryActionDeleteImage: ({ excerpt }: { excerpt: string }) => `删除画廊图片：${excerpt}`,
  galleryActionDownloadImage: ({ excerpt }: { excerpt: string }) => `下载图片：${excerpt}`,
  galleryActionOpenImage: ({ excerpt }: { excerpt: string }) => `打开图片详情：${excerpt}`,
  galleryActionOpenLatest: ({ excerpt }: { excerpt: string }) => `打开最新作品详情：${excerpt}`,
  galleryActionReusePrompt: ({ excerpt }: { excerpt: string }) => `复用提示词：${excerpt}`,
  galleryBadgeLatest: "最新",
  galleryConfirmDeleteBody: ({ excerpt }: { excerpt: string }) =>
    `将从画廊和生成历史移除“${excerpt}”。画布中的图片、本地文件和资产记录会保留。`,
  galleryConfirmRemove: "确认移除",
  galleryConfirmDeleteTitle: "移除这张画廊图片？",
  galleryCopiedPrompt: "已复制提示词。",
  galleryDeleteFailed: "删除失败，请重试。",
  galleryDeleted: "已从画廊和生成历史移除。",
  galleryDetailEyebrow: "画廊详情",
  galleryDetailTitle: "图片详情",
  galleryDownloadOriginal: "下载原图",
  galleryEmpty: "暂无作品",
  galleryEmptyHint: "生成成功的图片会出现在这里。",
  galleryHeaderMeta: ({ count }: { count: number }) => `${count} 张本地作品，按最新生成排序`,
  galleryKicker: "画廊",
  galleryLoadFailed: "画廊加载失败。",
  galleryLoading: "正在载入画廊...",
  galleryNoMatches: "没有匹配结果",
  galleryNoMatchesHint: "换一个提示词关键词再试试。",
  galleryOpenDownload: "已打开原图下载。",
  galleryPromptLabel: "提示词",
  galleryRemovedTitle: "从画廊移除",
  galleryRequestFailed: ({ status }: { status: number }) => `请求失败，状态 ${status}。`,
  galleryReuseToCanvas: "复用到画布",
  gallerySearchAria: "搜索画廊提示词",
  gallerySearchPlaceholder: "搜索提示词、主题或风格",
  galleryServiceInvalidData: "画廊服务返回了无法识别的数据。",
  galleryTitle: "作品图库",
  galleryToggleCollapse: "收起",
  galleryToggleExpand: "展开",
  galleryWorkCount: "张作品",
  galleryWorkSort: "最新生成",
  generationActiveTasks: ({ count }: { count: number }) => `当前 ${count} 个任务正在生成到画布，可继续下发新任务。`,
  generationAdvanced: "高级设置",
  generationAllSizes: "全部尺寸",
  generationCancelReference: "取消参考",
  generationCanvasFailed: "画布生成失败",
  generationCanvasLoading: "生成到画布中",
  generationCanvasNotReady: "画布未就绪。",
  generationCloudFailed: ({ count }: { count: number }) => `云端失败 ${count}`,
  generationCloudSavedButFailed: ({ count }: { count: number }) => `本地已保存，${count} 张云端上传失败`,
  generationCopiedPrompt: "已复制提示词。",
  generationCopyFailed: "复制失败，请手动复制提示词。",
  generationCountLabel: "数量",
  generationDownloadNoAsset: "这条历史记录没有可下载的本地资源。",
  generationDownloadOpened: "已打开原始资源下载。",
  generationEmptyHistory: "暂无记录。",
  generationErrorDefault: "生成失败，请重试。",
  generationFailedCount: ({ count }: { count: number }) => `${count} 张生成失败`,
  generationFailureReason: ({ summary, reason }: { summary: string; reason: string }) => `${summary} 失败原因：${reason}`,
  generationHistoryCloudBackup: "云端备份",
  generationHistoryCopyPrompt: ({ excerpt }: { excerpt: string }) => `复制历史提示词：${excerpt}`,
  generationHistoryCreatedAt: "创建时间",
  generationHistoryCount: ({ count }: { count: number }) => `${count} 条`,
  generationHistoryDownload: ({ excerpt }: { excerpt: string }) => `下载历史记录：${excerpt}`,
  generationHistoryExpand: ({ count }: { count: number }) => `展开 ${count} 条`,
  generationHistoryLocate: ({ excerpt }: { excerpt: string }) => `定位历史记录：${excerpt}`,
  generationHistoryNoDownload: "没有可下载的本地资源",
  generationHistoryOutputCount: "输出数量",
  generationHistoryRerun: ({ excerpt }: { excerpt: string }) => `重跑历史记录：${excerpt}`,
  generationHistorySize: "尺寸",
  generationHistoryTitle: "生成历史",
  generationHistoryImageMissing: "画布上找不到这张历史图片，可能已被删除。",
  generationImageInserted: ({ count }: { count: number }) => `已向画布插入 ${count} 张图像。`,
  generationImageInsertedPart: ({ count }: { count: number }) => `已向画布插入 ${count} 张图像`,
  generationImageOutputCount: ({ successful, total }: { successful: number; total: number }) => `${successful} / ${total} 张`,
  generationInsertedPartialBody: ({ inserted, failed }: { inserted: number; failed: number }) =>
    `已向画布插入 ${inserted} 张图像，${failed} 张失败。`,
  generationInvalidResponse: "生成服务返回了无法识别的结果。",
  generationGalleryReused: "已从画廊填入生成参数。",
  galleryImportedMessage: ({ count }: { count: number }) => `已导入 ${count} 张画廊图像到画布。`,
  galleryActionImport: "导入到画布",
  galleryBatchDownload: "批量下载",
  galleryBatchClear: "清空选择",
  galleryBatchSelected: ({ count }: { count: number }) => `已选 ${count} 张`,
  projectExport: "导出项目",
  generationLocatePending: "已定位到生成中的任务。",
  generationLocateSucceeded: "已定位到历史图像。",
  generationMissingPromptHistory: "这条历史记录没有可复制的提示词。",
  generationModeAria: "模式",
  generationModeLabel: "模式",
  generationMoreCount: "更多数量",
  generationMoreCountSelected: ({ count }: { count: number }) => `更多数量：${count} 张`,
  generationNoSuccessfulImage: "没有可插入的成功图像。",
  generationNotificationPartialTitle: "生成到画布部分完成",
  generationNotificationTitle: "已生成到画布",
  generationPanelAria: "AI 生成面板",
  generationPanelClose: "关闭生成到画布面板",
  generationOutputFormatLabel: "输出格式",
  generationPromptLabel: "提示词",
  generationPromptPlaceholder: "描述画面主体、场景、光线、构图和关键细节",
  generationQualityLabel: "质量",
  generationReferenceAlt: ({ index, name }: { index: number; name: string }) => `参考图 ${index}：${name}`,
  generationReferenceNeed: ({ max }: { max: number }) => `请选择 1-${max} 张参考图`,
  generationReferenceReady: ({ count }: { count: number }) => `${count} 张参考图到画布已就绪`,
  generationRequireReference: ({ max }: { max: number }) => `请先选择 1-${max} 张可用的参考图像。`,
  generationRerunRunning: "任务运行中",
  generationSelectedReferenceMany: ({ count }: { count: number }) =>
    `已选中 ${count} 张参考图，将按画布位置从上到下、从左到右发送。`,
  generationSelectedReferenceOne: "已选中 1 张图片，将使用它作为本次参考图。",
  generationSelectionMissingSource: "选中的图片缺少可读取的数据源，无法作为参考图。",
  generationSelectionNonImage: ({ max }: { max: number }) => `当前选择中包含非图片对象。请只圈选 1-${max} 张图片作为参考。`,
  generationSelectionTooMany: ({ count, max }: { count: number; max: number }) =>
    `当前选择了 ${count} 张图片。参考图最多支持 ${max} 张。`,
  generationSelectionUnreadable: "选中的图片当前无法被浏览器读取，请只选择本地生成或已导入的 PNG、JPEG、WebP 图片。",
  generationSizeLabel: "尺寸",
  generationStartReference: "参考图生成到画布",
  generationStartText: "生成到画布",
  generationStyleLabel: "风格",
  generationUnknownCancel: "已取消本次生成。",
  generationWidthLabel: "宽度",
  generationHeightLabel: "高度",
  historyCancelTask: ({ excerpt }: { excerpt: string }) => `取消生成任务：${excerpt}`,
  historyLocate: "定位",
  historyRerun: "重跑",
  homeAfterfoldAria: "创作入口",
  homeApiSetup: "接入 API",
  homeAuthChecking: "正在检查本地凭据",
  homeDeck: "把提示词、参考图、生成历史和视觉比较收束到一张本地画布里。",
  homeEntryAria: "进入方式",
  homeGallery: "打开画廊",
  homeKicker: "专业 AI 画布",
  homeProviderCodex: "Codex 会话已可用",
  homeProviderNone: "等待接入生成服务",
  homeProviderOpenAI: "OpenAI API 已接入",
  homeSecurityNote: "API Key 只在服务端环境读取，浏览器不会保存或回显密钥。",
  homeStartCodex: "Codex 登录",
  homeTitle: "专业 AI 画布",
  imageSizeAspectRatio: ({ maxRatio }: { maxRatio: number }) => `长边和短边比例不能超过 ${maxRatio}:1。`,
  imageSizeNotMultiple: ({ multiple }: { multiple: number }) => `宽度和高度必须是 ${multiple}px 的倍数。`,
  imageSizeNonInteger: "宽度和高度必须是整数。",
  imageSizeTooLarge: ({ max }: { max: number }) => `宽度和高度不能大于 ${max}px。`,
  imageSizeTooSmall: ({ min }: { min: number }) => `宽度和高度不能小于 ${min}px。`,
  imageSizeTotalTooLarge: ({ maxPixels }: { maxPixels: string }) => `总像素不能超过 ${maxPixels}。`,
  imageSizeTotalTooSmall: ({ minPixels }: { minPixels: string }) => `总像素不能小于 ${minPixels}。`,
  imageSizeUnsupportedPreset: "不支持的场景尺寸预设。",
  insufficientCredits: ({ count }: { count: number }) => `当前积分不足，本次需要 ${count} 积分。请联系管理员发放积分。`,
  languageAria: "语言",
  languageEn: "EN",
  languageZh: "中文",
  navCanvas: "画布",
  navGallery: "画廊",
  navHome: "首页",
  navMainAria: "主要页面",
  navOpenProviderConfig: "打开生成服务配置",
  navProviderConfig: "生成服务配置",
  navSettings: "配置",
  outputFormatLabel: ({ format }: { format: OutputFormat }) => outputFormatLabels[format],
  projectLoadFailed: "无法载入已保存项目，将使用空白画布。",
  promptRequired: "请输入提示词。",
  promptStarterAvatarLabel: "角色头像",
  promptStarterAvatarPrompt: "一个原创角色头像，温暖表情，清爽背景，细腻插画质感",
  promptStarterCityLabel: "城市夜景",
  promptStarterCityPrompt: "未来城市夜景，雨后街道，霓虹倒影，电影感光影",
  promptStarterInteriorLabel: "室内空间",
  promptStarterInteriorPrompt: "一间安静的现代工作室，清晨自然光，木质家具，干净构图",
  promptStarterProductLabel: "产品海报",
  promptStarterProductPrompt: "一张高端护肤品产品海报，水面反光，精致布光，留出清晰标题空间",
  providerAvailable: "可用",
  providerUnavailable: "不可用",
  providerAdvancedModel: "高级模型字段",
  providerApiOfficial: "官方 OpenAI API",
  providerBaseUrlPlaceholder: "留空使用官方 OpenAI API",
  providerCardEnvHint: "修改 .env 或运行时环境变量后，需要重启 API 服务才会生效。",
  providerCardLocalHint: "本地 API Key 只保存到本机 SQLite；读取接口只返回掩码。",
  providerCloseConfig: "关闭生成服务配置",
  providerConfigLoadFailed: "无法读取服务配置。",
  providerConfigLoading: "正在读取生成服务配置",
  providerConfigRequestFailed: ({ status }: { status: number }) => `服务配置请求失败，状态 ${status}。`,
  providerConfigSavedNoSource: "配置已保存，但还没有可用的生成服务。",
  providerConfigSavedWithSource: ({ source }: { source: string }) => `配置已保存，当前使用${source}。`,
  providerConfigSaveFailed: "保存服务配置失败。",
  providerConfigTitle: "生成服务配置",
  providerCurrent: ({ source }: { source: string }) => `当前：${source}`,
  providerCurrentNone: "当前：暂无可用",
  providerDragSource: ({ source }: { source: string }) => `拖动调整${source}优先级`,
  providerEnvOpenAIDescription: ({ sourceId }: { sourceId: ProviderSourceId }) => providerSourceDescriptions["zh-CN"][sourceId],
  providerEnvOpenAILabel: ({ sourceId }: { sourceId: ProviderSourceId }) => providerSourceLabels["zh-CN"][sourceId],
  providerFallbackOrder: "Fallback Order",
  providerFieldAccount: "账号",
  providerFieldAvailability: "可用性",
  providerFieldBaseUrl: "Base URL",
  providerFieldExpiresAt: "过期时间",
  providerFieldModel: "模型",
  providerFieldReason: "不可用原因",
  providerFieldRefreshedAt: "刷新时间",
  providerFieldTimeout: "超时",
  providerLocalApiKeyPlaceholder: "粘贴 OpenAI 或兼容端点 API Key",
  providerLocalApiKeySaved: ({ mask }: { mask: string }) => `已保存：${mask}，输入新 key 可替换`,
  providerLocalTimeoutInvalid: "本地 API 超时时间必须是正整数毫秒。",
  providerLoggedOut: "未登录",
  providerLoginCodex: "登录 Codex",
  providerLogoutCodex: "退出 Codex",
  providerMoveDown: ({ source }: { source: string }) => `下移${source}`,
  providerMoveUp: ({ source }: { source: string }) => `上移${source}`,
  providerNoReason: "无",
  providerPriorityNote: "按顺序选择第一个已配置且可用的来源；上游请求已经发出后不会自动切换到下一个来源。",
  providerPriorityTitle: "优先级",
  providerRefresh: "重新读取",
  providerSave: "保存配置",
  providerSavedSecret: ({ mask }: { mask: string }) => `当前保存值：${mask}`,
  providerSourceConfigured: "已配置，可参与生成",
  providerSourceMissingCodex: "未登录 Codex 或会话不可用",
  providerSourceMissingKey: "未保存本地 API Key",
  providerSourceMissingOpenAIKey: "未设置 OPENAI_API_KEY",
  providerSourcePending: "等待读取状态",
  providerStatusAria: ({ title }: { title: string }) => `图像服务：${title}`,
  providerStatusCodexCopy: "Codex 会话可用。",
  providerStatusCodexTitle: "Codex 已登录",
  providerStatusEnvCopy: "当前使用 .env 或运行时环境变量中的 OpenAI 兼容配置。",
  providerStatusEnvTitle: "环境 OpenAI",
  providerStatusGenericOpenAICopy: "当前使用 OpenAI 兼容 Images API。",
  providerStatusImageService: "图像服务",
  providerStatusLoadingCopy: "正在检查本地凭据。",
  providerStatusLoadingTitle: "检查登录状态",
  providerStatusLocalCopy: "当前使用应用内保存的 OpenAI 兼容配置。",
  providerStatusLocalTitle: "本地 OpenAI",
  providerStatusNoneCopy: "打开右上角配置，可保存本地 API 或登录 Codex。",
  providerStatusNoneTitle: "需要生成服务",
  providerTimeoutMs: "超时（毫秒）",
  qualityLabel: ({ quality }: { quality: ImageQuality }) => qualityLabels["zh-CN"][quality],
  readReferenceDataFailed: "无法读取参考图片数据。",
  readReferenceFailed: "无法读取当前参考图。请确认图片来自本地生成结果或浏览器可访问的图片数据。",
  readReferenceMissingFile: "无法读取当前参考图。请确认图片文件仍然存在。",
  readStoredReferenceFailed: "无法读取历史参考图。请确认原始资源仍然存在。",
  referenceFileTooLarge: "参考图像不能超过 50MB。",
  referenceHistoryFileTooLarge: "历史参考图像不能超过 50MB。",
  referenceHistoryInvalidType: "历史参考资源不是可用的图片格式。",
  referenceInvalidType: "当前参考资源不是可用的图片格式。",
  saveStatusError: "保存失败",
  saveStatusLoading: "正在载入",
  saveStatusPending: "待保存",
  saveStatusSaved: "已保存",
  saveStatusSaving: "保存中",
  sizePresetLabel: ({ presetId, fallback }: { presetId: string; fallback?: string }) => sizePresetLabels["zh-CN"][presetId] ?? fallback ?? presetId,
  sourceDescription: ({ sourceId }: { sourceId: ProviderSourceId }) => providerSourceDescriptions["zh-CN"][sourceId],
  sourceLabel: ({ sourceId }: { sourceId: ProviderSourceId }) => providerSourceLabels["zh-CN"][sourceId],
  statusLabel: ({ status }: { status: GenerationStatus }) => generationStatusLabels["zh-CN"][status],
  storageClose: "关闭云存储设置",
  storageEnabledCopy: "关闭后新图只写本地，已有云端对象保留。",
  storageEnabledLabel: "启用 COS 双写",
  storageEnabledTitle: "云存储已开启",
  storageEnabledMessage: "Cloud storage is enabled.",
  storageDisabledMessage: "Cloud storage is disabled.",
  storageLoadFailed: "Unable to load cloud storage settings.",
  storageSave: "保存",
  storageSaved: "Cloud storage settings saved.",
  storageSaveFailed: "Cloud storage settings could not be saved.",
  storageSettings: "云存储设置",
  storageSubtitle: "腾讯云 COS，生成图本地保存后同步上传。",
  storageTest: "测试",
  storageTestFailed: "Cloud storage test failed.",
  stylePresetLabel: ({ presetId, fallback }: { presetId: StylePresetId | string; fallback?: string }) =>
    stylePresetLabels["zh-CN"][presetId as StylePresetId] ?? fallback ?? presetId,
  timeoutFormat: ({ seconds }: { seconds: number }) => `${seconds}s`,
  timeFallback15Minutes: "15 分钟后",
  unreadableGallery: "画廊",
  modeLabel: ({ mode }: { mode: GenerationRecord["mode"] }) => generationModeLabels["zh-CN"][mode],
  galleryModeLabel: ({ mode }: { mode: "edit" | "generate" }) => (mode === "edit" ? "参考图" : "文生图")
};

type MessageValue = string | ((params: any) => string);
type CatalogShape<T extends Record<string, MessageValue>> = {
  [K in keyof T]: T[K] extends (params: infer P) => string ? (params: P) => string : string;
};
type I18nMessages = CatalogShape<typeof zhMessages>;

const enMessages: I18nMessages = {
  appCanvasAria: "gpt-image-canvas creative canvas",
  appGalleryLoading: "Loading Gallery...",
  appTagline: "Local AI image canvas",
  authStatusLoadFailed: "Unable to read image service sign-in status.",
  autosaveFailed: "Autosave failed. Your current canvas is preserved; keep editing and try again later.",
  canvasLoadingTitle: "Loading gpt-image-canvas",
  codexCloseLogin: "Close Codex login",
  codexCodeExpires: ({ time }) => `Code expires at ${time}.`,
  codexCopyCode: "Copy code",
  codexCreatingCode: "Creating login code...",
  codexLoginAuthorized: "Codex is signed in.",
  codexLoginFailedToStart: "Codex login could not be started.",
  codexLoginIncomplete: "Codex login did not complete. Start again.",
  codexLoginPollingFailed: "Codex login polling failed.",
  codexLoginSubtitle: "Authorize the local generation service with your Codex account.",
  codexLoginTitle: "Sign in to Codex",
  codexLogoutFailed: "Codex logout failed.",
  codexOpenLoginPage: "Open login page",
  codexPendingAuth: "Waiting for browser authorization.",
  codexRestart: "Start again",
  commonCancel: "Cancel",
  commonClose: "Close",
  commonCopy: "Copy",
  commonDownload: "Download",
  commonFailed: "Failed",
  commonListSeparator: ", ",
  commonNotRecorded: "Not recorded",
  commonNotSet: "Not set",
  commonRemove: "Remove",
  commonReuse: "Reuse",
  commonSaved: "Saved",
  commonSentenceEnd: ".",
  customSize: "Custom",
  customSizeManual: "Manual input",
  customSizeOption: "Custom size",
  errorFallback: ({ status }) => `Generation request failed with status ${status}.`,
  errorHttpSuffix: ({ status }) => ` (HTTP ${status})`,
  galleryActionCopyPrompt: ({ excerpt }) => `Copy prompt: ${excerpt}`,
  galleryActionDeleteImage: ({ excerpt }) => `Delete Gallery image: ${excerpt}`,
  galleryActionDownloadImage: ({ excerpt }) => `Download image: ${excerpt}`,
  galleryActionOpenImage: ({ excerpt }) => `Open image details: ${excerpt}`,
  galleryActionOpenLatest: ({ excerpt }) => `Open latest work details: ${excerpt}`,
  galleryActionReusePrompt: ({ excerpt }) => `Reuse prompt: ${excerpt}`,
  galleryBadgeLatest: "Latest",
  galleryConfirmDeleteBody: ({ excerpt }) =>
    `Remove "${excerpt}" from Gallery and generation history. Images on the canvas, local files, and asset records will be kept.`,
  galleryConfirmRemove: "Remove",
  galleryConfirmDeleteTitle: "Remove this Gallery image?",
  galleryCopiedPrompt: "Prompt copied.",
  galleryDeleteFailed: "Delete failed. Try again.",
  galleryDeleted: "Removed from Gallery and generation history.",
  galleryDetailEyebrow: "Image Record",
  galleryDetailTitle: "Image details",
  galleryDownloadOriginal: "Download original",
  galleryEmpty: "No works yet",
  galleryEmptyHint: "Successfully generated images will appear here.",
  galleryHeaderMeta: ({ count }) => `${count} local works, sorted by latest generation`,
  galleryKicker: "Local Archive",
  galleryLoadFailed: "Gallery failed to load.",
  galleryLoading: "Loading Gallery...",
  galleryNoMatches: "No matches",
  galleryNoMatchesHint: "Try another prompt keyword.",
  galleryOpenDownload: "Original download opened.",
  galleryPromptLabel: "Prompt",
  galleryRemovedTitle: "Remove from Gallery",
  galleryRequestFailed: ({ status }) => `Request failed with status ${status}.`,
  galleryReuseToCanvas: "Reuse on canvas",
  gallerySearchAria: "Search Gallery prompts",
  gallerySearchPlaceholder: "Search prompts, subjects, or styles",
  galleryServiceInvalidData: "Gallery returned unrecognized data.",
  galleryTitle: "Gallery",
  galleryToggleCollapse: "Collapse",
  galleryToggleExpand: "Expand",
  galleryWorkCount: "works",
  galleryWorkSort: "Latest",
  generationActiveTasks: ({ count }) => `${count} tasks are generating on the canvas. You can submit another task.`,
  generationAdvanced: "Advanced settings",
  generationAllSizes: "All sizes",
  generationCancelReference: "Cancel reference",
  generationCanvasFailed: "Canvas generation failed",
  generationCanvasLoading: "Generating on canvas",
  generationCanvasNotReady: "Canvas is not ready.",
  generationCloudFailed: ({ count }) => `Cloud failed ${count}`,
  generationCloudSavedButFailed: ({ count }) => `saved locally, ${count} cloud uploads failed`,
  generationCopiedPrompt: "Prompt copied.",
  generationCopyFailed: "Copy failed. Copy the prompt manually.",
  generationCountLabel: "Count",
  generationDownloadNoAsset: "This history record has no downloadable local asset.",
  generationDownloadOpened: "Original resource download opened.",
  generationEmptyHistory: "No records yet.",
  generationErrorDefault: "Generation failed. Try again.",
  generationFailedCount: ({ count }) => `${count} images failed`,
  generationFailureReason: ({ summary, reason }) => `${summary} Reason: ${reason}`,
  generationHistoryCloudBackup: "Cloud backup",
  generationHistoryCopyPrompt: ({ excerpt }) => `Copy history prompt: ${excerpt}`,
  generationHistoryCreatedAt: "Created",
  generationHistoryCount: ({ count }) => `${count} records`,
  generationHistoryDownload: ({ excerpt }) => `Download history record: ${excerpt}`,
  generationHistoryExpand: ({ count }) => `Expand ${count}`,
  generationHistoryLocate: ({ excerpt }) => `Locate history record: ${excerpt}`,
  generationHistoryNoDownload: "No downloadable local asset",
  generationHistoryOutputCount: "Output count",
  generationHistoryRerun: ({ excerpt }) => `Rerun history record: ${excerpt}`,
  generationHistorySize: "Size",
  generationHistoryTitle: "Generation history",
  generationHistoryImageMissing: "This history image could not be found on the canvas. It may have been deleted.",
  generationImageInserted: ({ count }) => `${count} images inserted onto the canvas.`,
  generationImageInsertedPart: ({ count }) => `${count} images inserted onto the canvas`,
  generationImageOutputCount: ({ successful, total }) => `${successful} / ${total} images`,
  generationInsertedPartialBody: ({ inserted, failed }) => `${inserted} images inserted onto the canvas, ${failed} failed.`,
  generationInvalidResponse: "The generation service returned an unrecognized result.",
  generationGalleryReused: "Generation settings filled from Gallery.",
  galleryImportedMessage: ({ count }) => `Imported ${count} gallery image(s) onto the canvas.`,
  galleryActionImport: "Import to canvas",
  galleryBatchDownload: "Batch download",
  galleryBatchClear: "Clear selection",
  galleryBatchSelected: ({ count }) => `${count} selected`,
  projectExport: "Export project",
  generationLocatePending: "Located the generating task.",
  generationLocateSucceeded: "Located the history image.",
  generationMissingPromptHistory: "This history record has no prompt to copy.",
  generationModeAria: "Mode",
  generationModeLabel: "Mode",
  generationMoreCount: "More counts",
  generationMoreCountSelected: ({ count }) => `More counts: ${count}`,
  generationNoSuccessfulImage: "No successful images can be inserted.",
  generationNotificationPartialTitle: "Canvas generation partially complete",
  generationNotificationTitle: "Generated onto canvas",
  generationPanelAria: "AI generation panel",
  generationPanelClose: "Close generation panel",
  generationOutputFormatLabel: "Output format",
  generationPromptLabel: "Prompt",
  generationPromptPlaceholder: "Describe the subject, scene, lighting, composition, and key details",
  generationQualityLabel: "Quality",
  generationReferenceAlt: ({ index, name }) => `Reference image ${index}: ${name}`,
  generationReferenceNeed: ({ max }) => `Select 1-${max} reference images`,
  generationReferenceReady: ({ count }) => `${count} reference images are ready`,
  generationRequireReference: ({ max }) => `Select 1-${max} usable reference images first.`,
  generationRerunRunning: "Task running",
  generationSelectedReferenceMany: ({ count }) =>
    `${count} reference images selected. They will be sent top-to-bottom, left-to-right by canvas position.`,
  generationSelectedReferenceOne: "1 image selected and will be used as this reference.",
  generationSelectionMissingSource: "The selected image has no readable data source.",
  generationSelectionNonImage: ({ max }) => `The selection includes non-image objects. Select only 1-${max} images as references.`,
  generationSelectionTooMany: ({ count, max }) => `${count} images selected. Reference images support up to ${max}.`,
  generationSelectionUnreadable: "The selected image cannot be read by the browser. Use locally generated or imported PNG, JPEG, or WebP images.",
  generationSizeLabel: "Size",
  generationStartReference: "Generate from references",
  generationStartText: "Generate to canvas",
  generationStyleLabel: "Style",
  generationUnknownCancel: "This generation was cancelled.",
  generationWidthLabel: "Width",
  generationHeightLabel: "Height",
  historyCancelTask: ({ excerpt }) => `Cancel generation task: ${excerpt}`,
  historyLocate: "Locate",
  historyRerun: "Rerun",
  homeAfterfoldAria: "Creation entry",
  homeApiSetup: "Connect API",
  homeAuthChecking: "Checking local credentials",
  homeDeck: "Bring prompts, references, generation history, and visual comparison into one local canvas.",
  homeEntryAria: "Entry options",
  homeGallery: "Open Gallery",
  homeKicker: "Local Creation Tool",
  homeProviderCodex: "Codex session available",
  homeProviderNone: "Waiting for a generation service",
  homeProviderOpenAI: "OpenAI API connected",
  homeSecurityNote: "API keys are read only on the server. The browser never stores or echoes secrets.",
  homeStartCodex: "Sign in with Codex",
  homeTitle: "Professional AI Canvas",
  imageSizeAspectRatio: ({ maxRatio }) => `The long-to-short side ratio cannot exceed ${maxRatio}:1.`,
  imageSizeNotMultiple: ({ multiple }) => `Width and height must be multiples of ${multiple}px.`,
  imageSizeNonInteger: "Width and height must be integers.",
  imageSizeTooLarge: ({ max }) => `Width and height cannot be larger than ${max}px.`,
  imageSizeTooSmall: ({ min }) => `Width and height cannot be smaller than ${min}px.`,
  imageSizeTotalTooLarge: ({ maxPixels }) => `Total pixels cannot exceed ${maxPixels}.`,
  imageSizeTotalTooSmall: ({ minPixels }) => `Total pixels cannot be less than ${minPixels}.`,
  imageSizeUnsupportedPreset: "Unsupported scene size preset.",
  insufficientCredits: ({ count }) => `Not enough credits. This request needs ${count} credits. Ask the administrator to grant credits.`,
  languageAria: "Language",
  languageEn: "EN",
  languageZh: "中文",
  navCanvas: "Canvas",
  navGallery: "Gallery",
  navHome: "Home",
  navMainAria: "Main pages",
  navOpenProviderConfig: "Open generation service settings",
  navProviderConfig: "Generation service settings",
  navSettings: "Settings",
  outputFormatLabel: ({ format }) => outputFormatLabels[format],
  projectLoadFailed: "Saved project could not be loaded. Starting with a blank canvas.",
  promptRequired: "Enter a prompt.",
  promptStarterAvatarLabel: "Character avatar",
  promptStarterAvatarPrompt: "An original character avatar, warm expression, clean background, refined illustration texture",
  promptStarterCityLabel: "City night",
  promptStarterCityPrompt: "Futuristic city night scene, wet streets after rain, neon reflections, cinematic lighting",
  promptStarterInteriorLabel: "Interior space",
  promptStarterInteriorPrompt: "A quiet modern studio, morning natural light, wood furniture, clean composition",
  promptStarterProductLabel: "Product poster",
  promptStarterProductPrompt: "A premium skincare product poster, water reflections, refined lighting, clear headline space",
  providerAvailable: "Available",
  providerUnavailable: "Unavailable",
  providerAdvancedModel: "Advanced model fields",
  providerApiOfficial: "Official OpenAI API",
  providerBaseUrlPlaceholder: "Leave blank to use the official OpenAI API",
  providerCardEnvHint: "Restart the API service after changing .env or runtime environment variables.",
  providerCardLocalHint: "The local API key is stored only in local SQLite; read APIs return only the mask.",
  providerCloseConfig: "Close generation service settings",
  providerConfigLoadFailed: "Unable to read service settings.",
  providerConfigLoading: "Reading generation service settings",
  providerConfigRequestFailed: ({ status }) => `Provider settings request failed with status ${status}.`,
  providerConfigSavedNoSource: "Settings saved, but no generation service is available yet.",
  providerConfigSavedWithSource: ({ source }) => `Settings saved. Current source: ${source}.`,
  providerConfigSaveFailed: "Provider settings could not be saved.",
  providerConfigTitle: "Generation Service Settings",
  providerCurrent: ({ source }) => `Current: ${source}`,
  providerCurrentNone: "Current: none available",
  providerDragSource: ({ source }) => `Drag to adjust ${source} priority`,
  providerEnvOpenAIDescription: ({ sourceId }) => providerSourceDescriptions.en[sourceId],
  providerEnvOpenAILabel: ({ sourceId }) => providerSourceLabels.en[sourceId],
  providerFallbackOrder: "Routing Priority",
  providerFieldAccount: "Account",
  providerFieldAvailability: "Availability",
  providerFieldBaseUrl: "Base URL",
  providerFieldExpiresAt: "Expires at",
  providerFieldModel: "Model",
  providerFieldReason: "Unavailable reason",
  providerFieldRefreshedAt: "Refreshed at",
  providerFieldTimeout: "Timeout",
  providerLocalApiKeyPlaceholder: "Paste an OpenAI or compatible endpoint API key",
  providerLocalApiKeySaved: ({ mask }) => `Saved: ${mask}. Enter a new key to replace it`,
  providerLocalTimeoutInvalid: "Local API timeout must be a positive integer in milliseconds.",
  providerLoggedOut: "Not signed in",
  providerLoginCodex: "Sign in to Codex",
  providerLogoutCodex: "Sign out of Codex",
  providerMoveDown: ({ source }) => `Move ${source} down`,
  providerMoveUp: ({ source }) => `Move ${source} up`,
  providerNoReason: "None",
  providerPriorityNote: "The first configured and available source is selected in order; in-flight upstream requests do not automatically fail over.",
  providerPriorityTitle: "Priority",
  providerRefresh: "Refresh",
  providerSave: "Save settings",
  providerSavedSecret: ({ mask }) => `Current saved value: ${mask}`,
  providerSourceConfigured: "Configured and available for generation",
  providerSourceMissingCodex: "Not signed in to Codex or the session is unavailable",
  providerSourceMissingKey: "No local API key saved",
  providerSourceMissingOpenAIKey: "OPENAI_API_KEY is not set",
  providerSourcePending: "Waiting for status",
  providerStatusAria: ({ title }) => `Image service: ${title}`,
  providerStatusCodexCopy: "Codex session available.",
  providerStatusCodexTitle: "Codex signed in",
  providerStatusEnvCopy: "Using OpenAI-compatible settings from .env or runtime environment variables.",
  providerStatusEnvTitle: "Environment OpenAI",
  providerStatusGenericOpenAICopy: "Using an OpenAI-compatible Images API.",
  providerStatusImageService: "Image service",
  providerStatusLoadingCopy: "Checking local credentials.",
  providerStatusLoadingTitle: "Checking sign-in status",
  providerStatusLocalCopy: "Using the OpenAI-compatible settings saved in this app.",
  providerStatusLocalTitle: "Local OpenAI",
  providerStatusNoneCopy: "Open settings in the upper right to save a local API key or sign in to Codex.",
  providerStatusNoneTitle: "Generation service needed",
  providerTimeoutMs: "Timeout (ms)",
  qualityLabel: ({ quality }) => qualityLabels.en[quality],
  readReferenceDataFailed: "Unable to read reference image data.",
  readReferenceFailed: "Unable to read the current reference image. Confirm that it was locally generated or is browser-accessible.",
  readReferenceMissingFile: "Unable to read the current reference image. Confirm that the image file still exists.",
  readStoredReferenceFailed: "Unable to read the historical reference image. Confirm that the original asset still exists.",
  referenceFileTooLarge: "Reference images cannot exceed 50MB.",
  referenceHistoryFileTooLarge: "Historical reference images cannot exceed 50MB.",
  referenceHistoryInvalidType: "Historical reference asset is not a usable image format.",
  referenceInvalidType: "Current reference asset is not a usable image format.",
  saveStatusError: "Save failed",
  saveStatusLoading: "Loading",
  saveStatusPending: "Unsaved",
  saveStatusSaved: "Saved",
  saveStatusSaving: "Saving",
  sizePresetLabel: ({ presetId, fallback }) => sizePresetLabels.en[presetId] ?? fallback ?? presetId,
  sourceDescription: ({ sourceId }) => providerSourceDescriptions.en[sourceId],
  sourceLabel: ({ sourceId }) => providerSourceLabels.en[sourceId],
  statusLabel: ({ status }) => generationStatusLabels.en[status],
  storageClose: "Close cloud storage settings",
  storageEnabledCopy: "When off, new images are stored locally only. Existing cloud objects are kept.",
  storageEnabledLabel: "Enable COS dual write",
  storageEnabledTitle: "Cloud storage enabled",
  storageEnabledMessage: "Cloud storage is enabled.",
  storageDisabledMessage: "Cloud storage is disabled.",
  storageLoadFailed: "Unable to load cloud storage settings.",
  storageSave: "Save",
  storageSaved: "Cloud storage settings saved.",
  storageSaveFailed: "Cloud storage settings could not be saved.",
  storageSettings: "Cloud storage settings",
  storageSubtitle: "Tencent Cloud COS syncs generated images after local save.",
  storageTest: "Test",
  storageTestFailed: "Cloud storage test failed.",
  stylePresetLabel: ({ presetId, fallback }) => stylePresetLabels.en[presetId as StylePresetId] ?? fallback ?? presetId,
  timeoutFormat: ({ seconds }) => `${seconds}s`,
  timeFallback15Minutes: "15 minutes later",
  unreadableGallery: "Gallery",
  modeLabel: ({ mode }) => generationModeLabels.en[mode],
  galleryModeLabel: ({ mode }) => (mode === "edit" ? "Reference" : "Text to image")
};

const messages: Record<Locale, I18nMessages> = {
  "zh-CN": zhMessages,
  en: enMessages
};

type FunctionMessageKey = {
  [K in keyof I18nMessages]: I18nMessages[K] extends (params: any) => string ? K : never;
}[keyof I18nMessages];
type StringMessageKey = Exclude<keyof I18nMessages, FunctionMessageKey>;
type MessageParams<K extends FunctionMessageKey> = I18nMessages[K] extends (params: infer P) => string ? P : never;

export type Translate = {
  <K extends StringMessageKey>(key: K): string;
  <K extends FunctionMessageKey>(key: K, params: MessageParams<K>): string;
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
  formatDateTime: (value: string, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage failures; language switching should still work in memory.
    }
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const t = useMemo(() => createTranslate(locale), [locale]);
  const formatDateTime = useCallback(
    (value: string, options: Intl.DateTimeFormatOptions = defaultDateTimeOptions): string => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }

      return new Intl.DateTimeFormat(locale, options).format(date);
    },
    [locale]
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      formatDateTime
    }),
    [formatDateTime, locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within LanguageProvider.");
  }

  return context;
}

export function localizedApiErrorMessage(input: {
  code?: string;
  fallbackMessage?: string;
  fallbackText: string;
  locale: Locale;
  status: number;
}): string {
  const mapped = input.code ? commonApiErrorMessages[input.locale][input.code] : undefined;
  const fallbackMessage = input.fallbackMessage?.trim();
  if (!mapped && !fallbackMessage) {
    return input.fallbackText;
  }

  return `${mapped ?? fallbackMessage}${messages[input.locale].errorHttpSuffix({ status: input.status })}`;
}

function createTranslate(locale: Locale): Translate {
  return ((key: keyof I18nMessages, params?: unknown) => {
    const value = messages[locale][key];
    if (typeof value === "function") {
      return value(params as never);
    }
    return value;
  }) as Translate;
}

function initialLocale(): Locale {
  return readStoredLocale() ?? "zh-CN";
}

function readStoredLocale(): Locale | undefined {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isLocale(value: string | null): value is Locale {
  return value === "zh-CN" || value === "en";
}

const defaultDateTimeOptions: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
};
