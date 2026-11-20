// 管理者の操作の記録に共通の列（LOG-4）。at は秒を切り捨てない時刻（TIM-5）
export function adminEvent(now, auth, event) {
  return { at: now, actor_kind: 'admin', actor_admin_id: auth.admin.id, ...event };
}
