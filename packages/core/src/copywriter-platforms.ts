/**
 * Platform rule bundles for the copywriter tab. Each string is embedded
 * verbatim into Claude's system prompt when generating copy for that
 * platform. Content distilled from ~/.claude/skills/wilon@copywriter/
 * references/*.md — kept compact enough to fit comfortably in the prompt
 * context while preserving the hard constraints (length limits, banned
 * words, structural skeletons).
 *
 * Any time these rules evolve: update here, not at the skill level, so
 * the packaged app stays self-contained.
 */

export type SocialPlatform =
  | 'xiaohongshu'
  | 'instagram'
  | 'tiktok'
  | 'youtube'
  | 'twitter';

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  xiaohongshu: '小红书',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  twitter: 'X (Twitter)',
};

const XIAOHONGSHU_RULES = `
# 小红书规则

## 平台调性
图文笔记为主。用户追求真实分享感,"闺蜜推荐"语气最有效。
算法看: 点击率 → 互动率(收藏 > 点赞) → 完读率。

## 硬性字数
- **标题: ≤ 20 字(含标点/emoji)。生成后必须数字数,超就重写。**
- 正文: 200-500 字为宜,最多 1000 字。
- Hashtag: 5-10 个,中文为主。

## 标题公式
- 数字钩子: "3个被 99%的人忽略的 XX 真相"
- 反直觉: "以为 XX 很重要?其实 YY 才是"
- 痛点共鸣: "每次 XX 我都崩溃"
- 悬念: "XX 之后,我才明白..."
- 必须含 1-2 个 emoji(开头或关键词旁)。

## 正文结构
开头 2 句破题 → 分段列清单/故事 → 结尾 CTA(建议码住/评论交流等)。
多用 emoji 分隔视觉,短句为主,避免大段长文本。

## ⚠️ 敏感词(必须避开,会限流)
- 绝对化: 最好/最佳/唯一/第一/100%/绝对 → 用"超推荐/个人觉得很不错/亲测"
- 营销: 购买/价格/折扣/促销 → 用"入手/成本大概/性价比高"
- 金额数字 + 货币符号 → 用 💰 emoji 模糊化("几百块"可以)
- 创业高危: 月入 X 万/暴富/躺赚/代理/加盟 → 禁用
- 医疗功效: 治疗/减肥/美白祛斑 → 禁用
- 外部平台名: 淘宝/抖音/京东 → 删除
- 诱导互动: 求转发/必看/不看后悔 → 用"值得看看/建议码住"

## Hashtag
5-10 个中文标签,精准 + 泛流量组合。例如:
#创业日记 #个人成长 #自由职业 #小众分享 #干货
`;

const INSTAGRAM_RULES = `
# Instagram 规则

## 平台调性
图片/Carousel + Caption,视觉优先,国际化。
算法看: 停留 → 互动(Save > Share > Comment > Like) → 推荐。

## 语言规则
**跟随原视频语言**。中文视频 → 中文 Caption。不要擅自翻成英文。
马来华人/双语场景: 中文为主,可穿插 studio / appointment 等自然词。

## 硬性字数
- Caption 总长: ≤ 2200 字符
- **Hook(折叠线前 125 字符): 最关键,决定是否展开**
- Hashtag: 10-30 个

## 结构
Hook(≤125 char) → 空行(用 . 或 ⠀ 占位) → 正文段落 → CTA → 占位行 → Hashtags

## Hook 公式(前 125 字符)
- 问题开头: "Ever wondered why your perfume fades in 2 hours?"
- 大胆声明: "I stopped buying designer fragrances. Here's why."
- 数字承诺: "3 things I wish I knew before starting my business"

## CTA
引导 Save(收藏)和评论,避免硬广口吻。
例: "Save this for later." / "Which one resonates with you? Comment below."

## Hashtag
10-30 个,英文为主(中文内容也可中英混搭):
- 大词(100w+): #entrepreneur #selfgrowth
- 中词(10-100w): #businesstips #mindsetcoach
- 小词/利基(<10w): #chineseentrepreneur #kualalumpurbusiness
组合策略: 3 大词 + 5-7 中词 + 5-10 小词
`;

const TIKTOK_RULES = `
# TikTok 规则

## 平台调性
短视频 caption,极短促,节奏快。
算法看: 完播率 > 点赞率 > 分享率 > 评论率。

## 硬性字数
- **Caption: ≤ 150 字(中文) / 150 characters(英文)**
- Hashtag: 3-5 个
- 无独立标题概念

## 结构
一句钩子(问句/大胆主张) + 1-2 句补充 + 3-5 hashtag。
可用 emoji 但不要太多。

## Hook 公式
- 悬念: "他说的一句话改变了我的职业"
- 反转: "以为 XX 才赚钱?错!"
- 挑战式: "我用 7 天证明..."

## CTA
"评论区告诉我"/"follow 看下集"/"收藏慢慢看"——选一个即可,不要多。

## Hashtag
3-5 个,混合大词 + 利基:
- 中文: #创业日记 #小众分享 #职场
- 英文: #fyp #entrepreneur #tips
`;

const YOUTUBE_RULES = `
# YouTube 规则

## 平台调性
信息密度高,SEO 导向,描述区是"第二信息层"。
算法看: 点击率(标题+缩略图) → 观看时长 → 互动。

## 语言规则
跟随视频语言。关键词可双语部署提升搜索。

## 硬性字数
- **标题: ≤ 100 字符,建议 50-70**
- 描述: ≤ 5000 字符,前 150 字符(约 2-3 行)最关键

## 标题公式
- 问题 + 解答: "为什么客户一开口就跑?销售的底层逻辑"
- 数字: "创业新手最常犯的 3 个定价错误"
- 悬念: "全世界推销最强的人,竟然是..."
- 系列编号: "坐垫谈 EP2｜利他成交"
- 关键词前置,不要全大写,不要标题党

## 描述结构
[首段 150 字: 核心摘要 + 关键词 + 视频价值]

[详述 2-3 段: 展开要点]

[时间戳章节(可选): 00:00 开场 / 01:23 主题一...]

[CTA: 订阅 / 评论 / 合作邮箱]

[社交 / 相关链接]

[尾部 hashtag 区]

## Hashtag
3-10 个,前 3 个会显示在标题上方,用最精准的关键词。
例: #创业 #商业思维 #销售技巧
`;

const TWITTER_RULES = `
# X (Twitter) 规则

## 平台调性
硬字数限制,一条即一个观点,追求 retweet/quote。

## 硬性字数
- **Post 正文: ≤ 280 字符**(含 hashtag / URL)
- Hashtag: 2-4 个(太多降低严肃感)
- 无独立标题字段

## 结构
一句 hook + 可选一句支撑 + 收尾金句或 CTA。
可用 thread(串)但本次只生成 single post。

## Hook 公式
- 反直觉声明: "Everyone says X. Actually Y."
- 数据冲击: "I analyzed 100 startups. 89% made this mistake."
- 身份 + 痛点: "If you're a founder and..."

## Hashtag
2-4 个,行业相关,放末尾。
`;

export const PLATFORM_RULES: Record<SocialPlatform, string> = {
  xiaohongshu: XIAOHONGSHU_RULES.trim(),
  instagram: INSTAGRAM_RULES.trim(),
  tiktok: TIKTOK_RULES.trim(),
  youtube: YOUTUBE_RULES.trim(),
  twitter: TWITTER_RULES.trim(),
};
