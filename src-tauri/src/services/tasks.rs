use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    CreateTaskInput, Task, TaskLinkInput, TaskQuery, TaskStats, UpdateTaskInput,
};

pub struct TaskService;

impl TaskService {
    pub fn list(db: &Database, query: TaskQuery) -> Result<Vec<Task>, AppError> {
        db.list_tasks(query)
    }

    pub fn get(db: &Database, id: i64) -> Result<Option<Task>, AppError> {
        db.get_task(id)
    }

    pub fn create(db: &Database, input: CreateTaskInput) -> Result<i64, AppError> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::InvalidInput("任务标题不能为空".into()));
        }
        if let Some(p) = input.priority {
            if !(0..=2).contains(&p) {
                return Err(AppError::InvalidInput(format!("非法的 priority: {}", p)));
            }
        }
        db.create_task(input)
    }

    pub fn update(db: &Database, id: i64, input: UpdateTaskInput) -> Result<bool, AppError> {
        if let Some(t) = input.title.as_ref() {
            if t.trim().is_empty() {
                return Err(AppError::InvalidInput("任务标题不能为空".into()));
            }
        }
        if let Some(p) = input.priority {
            if !(0..=2).contains(&p) {
                return Err(AppError::InvalidInput(format!("非法的 priority: {}", p)));
            }
        }
        db.update_task(id, input)
    }

    pub fn toggle_status(db: &Database, id: i64) -> Result<i32, AppError> {
        db.toggle_task_status(id)
    }

    pub fn delete(db: &Database, id: i64) -> Result<bool, AppError> {
        db.delete_task(id)
    }

    pub fn add_link(db: &Database, task_id: i64, input: TaskLinkInput) -> Result<i64, AppError> {
        db.add_task_link(task_id, input)
    }

    pub fn remove_link(db: &Database, link_id: i64) -> Result<bool, AppError> {
        db.remove_task_link(link_id)
    }

    pub fn stats(db: &Database) -> Result<TaskStats, AppError> {
        db.get_task_stats()
    }
}
