import { hashCommandPayload } from '@/lib/contracts/payload-hash'

/**
 * Deterministic relation id (依赖域合同 D11 / D15).
 *
 * ``"rel_" + sha256(rfc8785({space_id, from_work_item_id, to_work_item_id,
 * relation_type}))[:32]``
 *
 * ★ 必须与后端 ``app.task_space.contracts.relation_id`` **逐字节一致**：
 *   键名用 snake_case、对象键按 RFC 8785 排序、哈希取前 32 位十六进制。
 *   已用双向探针验证：两者对 ``("s1","a","b","depends_on")`` 都产出
 *   ``rel_2c61ac46bb2d74811301ed31af4947c1``。
 *
 * 有了确定性 id：
 * - 离线多端各自声明同一条逻辑边 → 收敛成同一行，不产生重复；
 * - 客户端能直接算出删除目标的路径 id，无需先读回服务器行。
 */
export async function relationId(
  spaceId: string,
  fromWorkItemId: string,
  toWorkItemId: string,
  relationType: string,
): Promise<string> {
  const digest = await hashCommandPayload({
    space_id: spaceId,
    from_work_item_id: fromWorkItemId,
    to_work_item_id: toWorkItemId,
    relation_type: relationType,
  })
  return `rel_${digest.slice(0, 32)}`
}
