import type { StyleTemplate } from "./types.js";

/**
 * Built-in style templates (read-only at runtime).
 * Genre flavor lives here; cross-template anti-mechanical / anti-stacking rules live in
 * `naturalProseCraftPrompt()` (stable style grounding) so every template inherits them.
 */
export const BUILTIN_STYLE_TEMPLATES: StyleTemplate[] = [
  {
    id: "webnovel-power",
    name: "网文爽文",
    description: "快节奏、爽点密集、章尾钩子 — 适合网络连载、升级流、系统文（仍须防清单感与指标堆砌）",
    systemPromptAddition: `写作风格指令（网文爽文）：
- 节奏：快，段落多 2—4 句；允许短句加速冲突，但禁止整章单句成段连打。每章结尾留一个悬念或情绪钩子，钩子要具体（未揭的威胁/未兑现的承诺），不要空泛金句。
- 视角：主角中心，爽点明确（打脸、升级、收获资源/认可至少其一）。爽点靠场面兑现，不要用旁白宣告“他变强了”。
- 对白：简洁有力；每句有功能（推进、性格、冲突）。允许一句狠话，禁止全员轮流毒舌或段子拼盘。
- 描写：环境服务氛围，战斗/冲突用短句；系统面板可出现，但同一场景内面板/数值刷屏不超过必要的一行两次。
- 类型特忌：大段世界观说明、冗长心理、文绉绉书面语；升级写成“任务清单勾选”或连续“提示音→数值→下一提示音”。
- 与全局自然叙事原则一致：反机械短段、反解释回声、反堆砌同义感官。`,
    suggestedTemperature: 0.9,
    suggestedTopP: 0.95,
    exampleContent: `林玄睁开眼，发现自己躺在一间破旧的木屋里。
【叮——万界最强系统已激活】
【新手任务：三日之内突破炼气一层。奖励：洗髓丹×1】
他猛地坐起来。穿越了？还带了个系统？
原身的记忆涌上来：这个世界强者为尊，炼气期连给大宗门看门的资格都没有。他只有三天。
三天后，林玄一掌劈开木门。门外正好站着三个来收保护费的散修。
为首那人愣了一下：“你小子……突破了？”
林玄没说话，只是抬手。
三人齐齐倒飞出去。`,
    exampleNotes: "快，但有场面因果：系统只给一次必要信息，爽点靠动作落地，不堆数值与旁白总结。",
  },
  {
    id: "literary",
    name: "传统文学",
    description: "描写细腻、心理层次丰富、节奏从容 — 适合严肃文学、历史题材（细不等于堆砌）",
    systemPromptAddition: `写作风格指令（传统文学）：
- 描写：感官可细，但每个意象须服务心理或主题；禁止为“细腻”而连写三层同义感官（看+听+闻全开却无新信息）。
- 心理：优先自由间接引语，少写“他想/他感到”；情绪由动作、物件、节奏带出，不事后翻译。
- 节奏：允许从容铺陈与蓄势，但不强制每段都有象征；场景过渡可以渐进，忌用总结句收每段。
- 语言：准确先于漂亮；比喻偶用且新鲜，禁止排比金句连发和“不是A而是B”式抽象重定义。
- 对白：符合身份与时代，带潜台词；人物不必句句深刻。
- 类型特忌：空洞华丽、情绪标签堆叠、快餐爆点；也忌把章节写成意象陈列清单。
- 与全局自然叙事原则一致：反机械、反堆砌、反贴金句收尾。`,
    suggestedTemperature: 0.7,
    suggestedTopP: 0.9,
    exampleContent: `陈秋禾站在窗前，看着院子里的梧桐。起风了。黄叶从枝头脱落的时候，好像犹豫了一下，在空中顿了顿，才不情不愿地往下坠。
厨房里传来母亲切菜的声响，规律而沉闷。父亲走后，母亲很少说话，只是不停地扫地、洗衣、做饭。
陈秋禾没有回头。窗玻璃上映出她的脸，和父亲年轻时真像。她抬手摸了摸那张脸，指腹只触到冰凉。
院门响了。邮递员的自行车铃刺破午后的寂静。
她浑身一僵。`,
    exampleNotes: "意象有选择：梧桐、刀声、玻璃够用，不叠第三层同义感官；收在具体打断，不升华。",
  },
  {
    id: "modern-commercial",
    name: "现代商业文学",
    description: "好读、有呼吸感、有内容，人物与情节并进 — 适合都市、职场、科幻日常、家庭、成长与类型融合",
    systemPromptAddition: `写作风格指令（现代商业文学）：
- 核心体验：清晰、流畅、当代感的叙事，承载有分量的人物与议题；深度来自选择与后果，不靠旁白讲道理。
- 阅读感：像跟人讲一件事，不是赶场/做教程。段落以 2—5 句为主；关键信息落地后给半拍落点再推进。
- 场景价值：每场至少完成两项（推进事件、改关系、露人物、增有效信息、造选择或收伏笔）。可留 1—2 句有效过渡换气；禁注水寒暄与已知信息复述。
- 人物：欲望、能力、局限与自我辩护并存；冲突来自合理但不兼容的诉求。
- 类型特忌（在全局反机械原则之上强调）：
  1) 禁止清单式章节（醒来→体检→说明→测试→评分）；
  2) 禁止「指令—执行—确认」连环短段与讲课式对白；
  3) 职场/科幻设定进冲突即可，禁止 HUD 式指标刷屏与“纳米原理”掐灭情绪；
  4) 收束落在后果或未决问题，不贴“迈出第一步”式金句。
- 语言：准确、具体、有动作感；趣味来自关系错位与现场反应，不用热梗拼盘。
- 与全局自然叙事原则一致：反机械短段、反无聊堆砌、反贴金句收尾。`,
    suggestedTemperature: 0.78,
    suggestedTopP: 0.9,
    exampleContent: `周一早上九点零七分，许知遥在公司前台看见了自己的工牌。

它挂在一个陌生男人胸前。照片是她，名字是她，职位却从“产品总监”变成了“项目顾问”。前台空调开得很足，塑封边缘那道旧裂口在灯下发白——去年出差摔的。

“打印机坏了。”前台姑娘压低声音，“行政说先拿旧卡顶一下。”

许知遥没有立刻接话。旧卡既没被销毁，也没锁在行政抽屉里，却落到一个即将坐进她办公室的人身上。男人顺着她的目光低头，摘下工牌递过来。

“抱歉，我不知道是谁的。”

“现在知道了。”她接过卡，没有戴上，“你叫什么？”

“程野。总部派来的。”

身后电梯叮的一声。老板站在门里，两杯咖啡，其中一杯显然不是给她的。他笑得很忙：“正好，都到了。十点组织调整会。知遥，你先带程野熟悉一下团队。”

许知遥也笑了笑，把旧工牌放进外套口袋，指节在布料里顿了一下，才按住开门键。

“当然。先从财务开始吧。”她说，“他接手的项目，上周刚多出八百万缺口。”

程野抬眼看她。那一瞬间，他不太像总部来的人。`,
    exampleNotes: "反机械示范：物件带信息，半拍停顿，对白有交锋，收在关系裂缝而非金句。",
  },
  {
    id: "light-novel",
    name: "轻小说",
    description: "对话为主、画面感强、语气轻松 — 适合校园、日常、恋爱喜剧（轻不等于水）",
    systemPromptAddition: `写作风格指令（轻小说）：
- 对白：占比可高（约 40—50%），靠拌嘴、误解、节奏制造趣味；每句仍须有目的，禁止无信息的车轱辘吐槽连发。
- 叙述：口吻轻松，可有轻主观吐槽，但不要每段都插旁白点评。
- 描写：动画分镜式 2—3 句勾场景即可；外貌首次出场一次交代，禁止反复描写同一特征凑字数。
- 节奏：开篇有吸引力（反常对话/场景/悬念）；节尾留钩子要具体。
- 类型特忌：严肃文学腔、大段心理分析、解释性破折号；也忌“吐槽模板”三连和全员抖机灵。
- 与全局自然叙事原则一致：反机械短段、反堆砌、反空洞金句。`,
    suggestedTemperature: 0.85,
    suggestedTopP: 0.95,
    exampleContent: `"所以说，你其实是异世界的勇者？"
我盯着面前这个自称转学生的银发少女，筷子停在半空。
"正是。"她双手抱胸，理所当然，"而你，就是我命中注定的同伴。"
"……哈？"
午休的教室只剩我们俩。窗外的阳光把她的银发照得晃眼。
"等等，"我放下筷子，"第一，勇者另请高明。第二，我对异世界没兴趣。第三——"
"第三，你手里那个便当里的章鱼香肠，就是我早上放在鞋柜里的。"
我低头看了看咬了一半的章鱼香肠。
"……哈？？？"
少女的脸微微红了："这、这是契约的证明！"
"你管这叫供品？！而且你往我鞋柜里放东西？！"`,
    exampleNotes: "对话推进有信息增量；吐槽不空转，钩在具体物件上。",
  },
  {
    id: "mystery",
    name: "悬疑推理",
    description: "伏笔铺垫、线索控制、紧张递进 — 适合推理、悬疑、犯罪（线索≠清单）",
    systemPromptAddition: `写作风格指令（悬疑推理）：
- 信息控制：每释放一条信息，最好同时种一个新疑问；不要一次解释所有线索。
- 伏笔：可疑细节融入动作与对话（物件错位、反常语气），禁止“线索清单”式罗列或每段末点题。
- 节奏：松→紧→更紧；危险/发现处可短句，但忌整章机关枪短段。
- 氛围：用日常中的异常与感官违和制造不安，同一异常不要用三种说法复读。
- 对白：可含误导与假线索；推理逐步展开，每步有依据，禁止侦探长篇演讲一次讲清。
- 类型特忌：碰巧捡关键线索、靠读者不知的信息强行反转、说明性破折号串线索。
- 与全局自然叙事原则一致：反机械、反堆砌、反贴金句收尾。`,
    suggestedTemperature: 0.75,
    suggestedTopP: 0.9,
    exampleContent: `沈酌接到消息的时候，正好站在周老师家门口。
"周老师……昨天夜里过世了。"
手机里的声音还在说什么，他已经听不进去。视线落在门缝里：一张对折的纸条，纸张还新。
他戴上手套，取出纸条。
只有一行字：
"第三次月考的试卷，你改错了。"
周老师已经退休三年了。
他推开虚掩的门。屋里的灯还亮着。桌上摊着一沓试卷，最上头用红笔改过，日期是昨天。
但周老师的右手，去年中风后就不能写字了。
玄关边上，一双不属于这个家的男式皮鞋，整齐地摆在那里。`,
    exampleNotes: "每条细节同时抛疑问；不罗列、不解说，让读者自己接。",
  },
  {
    id: "xianxia",
    name: "玄幻仙侠",
    description: "境界体系、战斗与修炼进程 — 适合修仙、东方玄幻（体系≠说明书）",
    systemPromptAddition: `写作风格指令（玄幻仙侠）：
- 体系：境界、功法、代价前后一致；突破须有条件或代价，不能随意抬战力。
- 战斗：开场对比、过程（招式名+气势+效果）、结果（损伤/震慑/局势变）；忌“大战三百回合”一笔带过，也忌招式名+特效堆砌而无局势变化。
- 修炼：灵气流转有画面，但同一突破不要用三段同义“力量觉醒”复述。
- 世界观：用行动与对白带出，禁止长篇设定段；法宝灵药有名字与一句来历即可。
- 语言：可半文半白；战斗对白短；少用现代网络词与说明腔破折号。
- 类型特忌：境界忽高忽低、宝物无铺垫空降、境界说明会式对白。
- 与全局自然叙事原则一致：反机械短段、反指标刷屏、反堆砌。`,
    suggestedTemperature: 0.85,
    suggestedTopP: 0.95,
    exampleContent: `青云宗，外门演武场。
数百名弟子围着擂台。台上身形单薄的少年握紧了拳——陆沉，炼气三层，外门倒数。
对面是炼气七层的赵恒，把玩着长剑，语气漫不经心：“现在跪下，我只打断一条腿。”
台下哄笑。
陆沉闭上眼。识海里浮现昨夜古玉碎片里的画面：灰袍身影在星河间出剑，斩断半片星海。那一剑叫什么，他不知道；他只模仿了一万次。
他睁开眼，灵气沿陌生轨迹运转。
“这一剑——”
他踏前一步，石板寸寸龟裂。
赵恒的笑容凝固了。`,
    exampleNotes: "实力差与招式蓄势服务局势变化；不堆境界名词说明书。",
  },
];

export function getStyleTemplate(id: string): StyleTemplate | undefined {
  return BUILTIN_STYLE_TEMPLATES.find((template) => template.id === id);
}

export function listStyleTemplates(): StyleTemplate[] {
  return BUILTIN_STYLE_TEMPLATES;
}

export function normalizeStyleTemplate(
  input: Partial<StyleTemplate>,
  options?: { fallbackId?: string },
): StyleTemplate {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("模板名称不能为空");
  if (name.length > 80) throw new Error("模板名称不能超过 80 个字符");
  const rawId = typeof input.id === "string" ? input.id.trim() : "";
  const id = rawId || options?.fallbackId || `custom-${Date.now().toString(36)}`;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) {
    throw new Error("模板 ID 只能使用小写字母、数字和连字符，最长 64 位");
  }
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const systemPromptAddition = typeof input.systemPromptAddition === "string" ? input.systemPromptAddition.trim() : "";
  const exampleContent = typeof input.exampleContent === "string" ? input.exampleContent.trim() : "";
  const exampleNotes = typeof input.exampleNotes === "string" ? input.exampleNotes.trim() : "";
  if (!description) throw new Error("模板简介不能为空");
  if (description.length > 500) throw new Error("模板简介不能超过 500 个字符");
  if (!systemPromptAddition) throw new Error("模板写作指令不能为空");
  if (systemPromptAddition.length > 20_000) throw new Error("模板写作指令不能超过 20000 个字符");
  if (exampleContent.length > 50_000) throw new Error("模板范文不能超过 50000 个字符");
  if (exampleNotes.length > 5_000) throw new Error("范文备注不能超过 5000 个字符");
  const suggestedTemperature = Number(input.suggestedTemperature);
  const suggestedTopP = Number(input.suggestedTopP);
  if (!Number.isFinite(suggestedTemperature) || suggestedTemperature < 0 || suggestedTemperature > 2) {
    throw new Error("temperature 必须在 0 到 2 之间");
  }
  if (!Number.isFinite(suggestedTopP) || suggestedTopP <= 0 || suggestedTopP > 1) {
    throw new Error("topP 必须大于 0 且不超过 1");
  }
  return {
    id, name, description, systemPromptAddition,
    suggestedTemperature, suggestedTopP, exampleContent, exampleNotes,
  };
}
