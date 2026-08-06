/**
 * Shared contract for turning structured project material into lived prose.
 * Keep this semantic: it describes decisions and relationships, not a word
 * substitution table. The stable style slot and delegated writers reuse it.
 */
export function proseRealizationContract(): string {
  return `资料到正文的表达转换契约：
- 设定字段先转换为当前视角人物正在注意什么、想完成什么、担心什么，以及这句话会对谁产生什么作用；先决定交际动作，再决定措辞。
- 规范术语、权限、时刻、读数、状态和分类是事实精度，不是普通对白或贴身叙述的默认词汇。正式汇报可以精确，普通对白只说对方此刻需要知道的部分，贴身叙述落到可感知的动作、感觉、比较或后果。
- 不把后台字段直接朗读成对白，也不把角色卡的摘要改写成旁白判断。必要事实要保留，但补足来源、对象、施事、受事、因果和人物的注意方向。
- 动作锚点必须有当前触发条件和现场功能；同一动作、口头习惯或短句只在本轮确实有理由时出现，不把它们做成角色签名或每轮配额。
- 不为显得干脆而删除必要关系，不用名词短语加裸谓词替代人物感知、回应和变化；省略只有在近邻语境能唯一补全且符合压力、身份和问答关系时才成立。
- 资料边界提供可用精度与语域方向，不提供固定替换句。事实、人物知识、交际目的和场景后果冲突时，优先保留事实并重新组织表达。`;
}
