import type { HubTaskBoard } from "@yibeibankaishui/archloop/hub-runtime-contract";

export const TaskBoardView = ({
  board,
  selectedTaskId,
  onSelectTask,
}: {
  readonly board?: HubTaskBoard;
  readonly selectedTaskId?: string;
  readonly onSelectTask: (taskId: string) => void;
}) => (
  <div className="hub-board">
    {board?.groups
      .filter((group) => group.tasks.length > 0)
      .map((group) => (
        <section key={group.status} className="hub-board-column">
          <header className="hub-board-column-header">
            <h2>{group.status}</h2>
            <span className="hub-chip">{group.tasks.length}</span>
          </header>
          <ul className="hub-board-cards">
            {group.tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={`hub-card hub-focus-ring ${selectedTaskId === task.id ? "is-selected" : ""}`}
                  onClick={() => onSelectTask(task.id)}
                >
                  <span className="hub-mono hub-card-id">{task.id}</span>
                  <span className="hub-card-title">{task.title}</span>
                  {task.claimState ? (
                    <span className="hub-chip is-active">{task.claimState}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )) ?? (
      <div className="hub-panel hub-empty">No local tasks available.</div>
    )}
  </div>
);
