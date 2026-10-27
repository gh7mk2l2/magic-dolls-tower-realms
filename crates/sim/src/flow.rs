use shared::{Rect, Vec2};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// 网格化地图：阻挡信息同时用于流场生成与英雄碰撞（客户端预测使用同一份网格）。
#[derive(Debug, Clone)]
pub struct NavGrid {
    pub cols: usize,
    pub rows: usize,
    pub cell_width: f32,
    pub cell_height: f32,
    pub blocked: Vec<bool>,
}

impl NavGrid {
    pub fn new(width: f32, height: f32, size: usize, obstacles: &[Rect]) -> Self {
        let cols = size.max(1);
        let rows = size.max(1);
        let cell_width = width / cols as f32;
        let cell_height = height / rows as f32;
        let mut blocked = vec![false; cols * rows];
        for y in 0..rows {
            for x in 0..cols {
                let cx = (x as f32 + 0.5) * cell_width;
                let cy = (y as f32 + 0.5) * cell_height;
                blocked[y * cols + x] = obstacles
                    .iter()
                    .any(|r| cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
            }
        }
        Self {
            cols,
            rows,
            cell_width,
            cell_height,
            blocked,
        }
    }

    pub fn cell_of(&self, position: Vec2) -> (usize, usize) {
        let x = ((position.x / self.cell_width) as isize).clamp(0, self.cols as isize - 1) as usize;
        let y =
            ((position.y / self.cell_height) as isize).clamp(0, self.rows as isize - 1) as usize;
        (x, y)
    }

    pub fn is_blocked_at(&self, position: Vec2) -> bool {
        let (x, y) = self.cell_of(position);
        self.blocked[y * self.cols + x]
    }

    pub fn center(&self, x: usize, y: usize) -> Vec2 {
        Vec2 {
            x: (x as f32 + 0.5) * self.cell_width,
            y: (y as f32 + 0.5) * self.cell_height,
        }
    }

    /// 按轴分离的滑动移动：被阻挡的轴不移动，另一轴继续，避免卡墙。
    /// 客户端 `prediction.ts::integrate` 实现完全相同的规则。
    pub fn slide(&self, from: Vec2, delta: Vec2, width: f32, height: f32) -> Vec2 {
        let mut result = from;
        let nx = (from.x + delta.x).clamp(0.0, width);
        if !self.is_blocked_at(Vec2 { x: nx, y: result.y }) {
            result.x = nx;
        }
        let ny = (from.y + delta.y).clamp(0.0, height);
        if !self.is_blocked_at(Vec2 { x: result.x, y: ny }) {
            result.y = ny;
        }
        result
    }

    pub fn blocked_bytes(&self) -> Vec<u8> {
        self.blocked.iter().map(|&b| u8::from(b)).collect()
    }
}

/// 以某一目标为终点的全图积分流场（8 方向 Dijkstra，直走代价 10、斜走 14）。
/// 所有同阵营魔兽共享同一份向量场，单位数量不影响寻路开销。
#[derive(Debug, Clone)]
pub struct FlowField {
    cols: usize,
    rows: usize,
    cell_width: f32,
    cell_height: f32,
    costs: Vec<u32>,
    /// 每个格子指向的下一格（u32::MAX 表示终点或不可达）。
    next: Vec<u32>,
    goal: Vec2,
}

const DIRS: [(isize, isize, u32); 8] = [
    (1, 0, 10),
    (-1, 0, 10),
    (0, 1, 10),
    (0, -1, 10),
    (1, 1, 14),
    (1, -1, 14),
    (-1, 1, 14),
    (-1, -1, 14),
];

impl FlowField {
    pub fn new(grid: &NavGrid, goal: Vec2) -> Self {
        let mut field = Self {
            cols: grid.cols,
            rows: grid.rows,
            cell_width: grid.cell_width,
            cell_height: grid.cell_height,
            costs: vec![u32::MAX; grid.cols * grid.rows],
            next: vec![u32::MAX; grid.cols * grid.rows],
            goal,
        };
        field.rebuild(grid);
        field
    }

    fn rebuild(&mut self, grid: &NavGrid) {
        let (gx, gy) = grid.cell_of(self.goal);
        let start = gy * self.cols + gx;
        self.costs[start] = 0;
        let mut heap = BinaryHeap::new();
        heap.push(Reverse((0u32, start)));
        while let Some(Reverse((cost, index))) = heap.pop() {
            if cost > self.costs[index] {
                continue;
            }
            let (x, y) = ((index % self.cols) as isize, (index / self.cols) as isize);
            for (dx, dy, step) in DIRS {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 || nx >= self.cols as isize || ny >= self.rows as isize {
                    continue;
                }
                let n = ny as usize * self.cols + nx as usize;
                if grid.blocked[n] {
                    continue;
                }
                // 斜向移动不允许切角穿过阻挡。
                if dx != 0 && dy != 0 {
                    let a = y as usize * self.cols + nx as usize;
                    let b = ny as usize * self.cols + x as usize;
                    if grid.blocked[a] || grid.blocked[b] {
                        continue;
                    }
                }
                let next_cost = cost + step;
                if next_cost < self.costs[n] {
                    self.costs[n] = next_cost;
                    self.next[n] = index as u32;
                    heap.push(Reverse((next_cost, n)));
                }
            }
        }
    }

    fn cell_of(&self, position: Vec2) -> usize {
        let x = ((position.x / self.cell_width) as isize).clamp(0, self.cols as isize - 1) as usize;
        let y =
            ((position.y / self.cell_height) as isize).clamp(0, self.rows as isize - 1) as usize;
        y * self.cols + x
    }

    /// 返回给定位置的单位移动方向（归一化）。
    pub fn direction(&self, position: Vec2) -> Vec2 {
        let index = self.cell_of(position);
        let next = self.next[index];
        let target = if next == u32::MAX {
            if self.costs[index] == 0 {
                self.goal
            } else {
                // 不可达（例如被推进阻挡内）：朝目标直线脱困。
                self.goal
            }
        } else {
            let n = next as usize;
            Vec2 {
                x: ((n % self.cols) as f32 + 0.5) * self.cell_width,
                y: ((n / self.cols) as f32 + 0.5) * self.cell_height,
            }
        };
        normalize(Vec2 {
            x: target.x - position.x,
            y: target.y - position.y,
        })
    }

    pub fn cost_at(&self, position: Vec2) -> u32 {
        self.costs[self.cell_of(position)]
    }

    pub fn dimensions(&self) -> (usize, usize) {
        (self.cols, self.rows)
    }
}

pub fn normalize(value: Vec2) -> Vec2 {
    let length = (value.x * value.x + value.y * value.y).sqrt();
    if length > f32::EPSILON {
        Vec2 {
            x: value.x / length,
            y: value.y / length,
        }
    } else {
        Vec2::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flow_routes_around_obstacle() {
        let wall = Rect {
            x: 400.0,
            y: 0.0,
            w: 100.0,
            h: 900.0,
        };
        let grid = NavGrid::new(1000.0, 1000.0, 20, &[wall]);
        let field = FlowField::new(&grid, Vec2 { x: 900.0, y: 100.0 });
        // 从墙左侧出发，必须先向下绕过墙底部。
        let mut p = Vec2 { x: 100.0, y: 100.0 };
        for _ in 0..400 {
            let d = field.direction(p);
            p = Vec2 {
                x: p.x + d.x * 10.0,
                y: p.y + d.y * 10.0,
            };
            assert!(!grid.is_blocked_at(p), "穿墙: {p:?}");
        }
        assert!((p.x - 900.0).abs() < 60.0 && (p.y - 100.0).abs() < 60.0);
    }

    #[test]
    fn slide_keeps_free_axis() {
        let wall = Rect {
            x: 500.0,
            y: 0.0,
            w: 100.0,
            h: 1000.0,
        };
        let grid = NavGrid::new(1000.0, 1000.0, 20, &[wall]);
        let p = grid.slide(
            Vec2 { x: 480.0, y: 300.0 },
            Vec2 { x: 40.0, y: 20.0 },
            1000.0,
            1000.0,
        );
        assert_eq!(p.x, 480.0);
        assert_eq!(p.y, 320.0);
    }
}
