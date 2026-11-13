import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance, passes } from "./check";
import { execute } from "./engine";
import { checkView, createLabState, type LabState } from "./state";

function sh(state: LabState, ...lines: string[]) {
  let out: string[] = [];
  let errors: string[] = [];
  for (const line of lines) {
    const result = execute(state, line);
    state = result.state;
    out = result.lines.filter((l) => !l.error).map((l) => l.text);
    errors = result.lines.filter((l) => l.error).map((l) => l.text);
  }
  return { state, out, errors, text: out.join("\n") };
}

interface RepoView {
  branch: string;
  branches: Record<string, true>;
  commitCount: number;
  lastMessage: string | null;
  staged: Record<string, true>;
  clean: boolean;
  branchFiles: Record<string, Record<string, true>>;
}
const repo = (state: LabState, path = "~/project") => (checkView(state) as { git: Record<string, RepoView> }).git[path];
const files = (state: LabState) => (checkView(state) as { files: Record<string, string> }).files;

/** A repository in ~/project with one commit containing README.md. */
const withCommit = () =>
  sh(createLabState(), "mkdir project && cd project && git init", "echo hello > README.md", "git add README.md", 'git commit -m "Add README"').state;

describe("git init and status", () => {
  it("creates a repository on main with a hidden .git directory", () => {
    const r = sh(createLabState(), "mkdir project", "cd project", "git init");
    expect(r.text).toBe("Initialized empty Git repository in /home/learner/project/.git/");
    expect(repo(r.state)).toMatchObject({ branch: "main", commitCount: 0, lastMessage: null, clean: true });
    expect(sh(r.state, "ls").out).toEqual([]);
    expect(sh(r.state, "ls -a").text).toBe(".git/");
    expect(sh(r.state, "git init").text).toMatch(/^Reinitialized existing/);
  });

  it("can initialise a named directory", () => {
    const s = sh(createLabState(), "git init app").state;
    expect(repo(s, "~/app").branch).toBe("main");
  });

  it("reports commands run outside a repository", () => {
    expect(sh(createLabState(), "git status").errors[0]).toMatch(/not a git repository/);
    expect(sh(createLabState(), "git add .").errors[0]).toMatch(/not a git repository/);
  });

  it("status shows untracked, staged and modified files in turn", () => {
    let s = sh(createLabState(), "git init project", "cd project", "echo a > a.txt").state;
    expect(sh(s, "git status").text).toMatch(/No commits yet[\s\S]*Untracked files:[\s\S]*\ta\.txt/);
    s = sh(s, "git add a.txt").state;
    expect(sh(s, "git status").text).toMatch(/Changes to be committed:\n\tnew file:   a\.txt/);
    s = sh(s, 'git commit -m "first"').state;
    expect(sh(s, "git status").text).toBe("On branch main\n\nnothing to commit, working tree clean");
    s = sh(s, "echo b >> a.txt").state;
    expect(sh(s, "git status").text).toMatch(/Changes not staged for commit:[\s\S]*\tmodified:   a\.txt/);
    expect(repo(s).clean).toBe(false);
    s = sh(s, "rm a.txt").state;
    expect(sh(s, "git status").text).toMatch(/\tdeleted:    a\.txt/);
  });

  it("works from a subdirectory of the repository", () => {
    const s = sh(createLabState(), "git init project", "mkdir -p project/src", "cd project/src", "echo x > main.py", "git add main.py").state;
    expect(repo(s).staged).toEqual({ "src/main.py": true });
  });
});

describe("git add", () => {
  const base = () => sh(createLabState({ files: { "~/project/a.txt": "a", "~/project/src/b.txt": "b" } }), "cd project", "git init").state;

  it("stages single files, directories, '.' and -A", () => {
    expect(repo(sh(base(), "git add a.txt").state).staged).toEqual({ "a.txt": true });
    expect(repo(sh(base(), "git add src").state).staged).toEqual({ "src/b.txt": true });
    expect(repo(sh(base(), "git add .").state).staged).toEqual({ "a.txt": true, "src/b.txt": true });
    expect(repo(sh(base(), "cd src", "git add -A").state).staged).toEqual({ "a.txt": true, "src/b.txt": true });
  });

  it("stages nothing when one path does not exist", () => {
    const r = sh(base(), "git add a.txt nope.txt");
    expect(r.errors[0]).toBe("fatal: pathspec 'nope.txt' did not match any files");
    expect(repo(r.state).staged).toEqual({});
  });

  it("stages a deletion and refuses paths outside the repository", () => {
    const s = sh(base(), "git add .", 'git commit -m "all"', "rm a.txt", "git add a.txt").state;
    expect(repo(s).staged).toEqual({ "a.txt": true });
    expect(repo(sh(s, 'git commit -m "remove a"').state).branchFiles.main).toEqual({ "src/b.txt": true });
    expect(sh(base(), "git add ~/other.txt").errors[0]).toMatch(/outside repository/);
  });

  it("explains a bare git add", () => {
    expect(sh(base(), "git add").errors[0]).toMatch(/Nothing specified/);
  });
});

describe("git commit and log", () => {
  it("records the staged snapshot and reports the root commit", () => {
    const r = sh(createLabState(), "git init project", "cd project", "echo hi > README.md", "git add .", 'git commit -m "Add README"');
    expect(r.out[0]).toMatch(/^\[main \(root-commit\) [0-9a-f]{7}\] Add README$/);
    expect(r.out[1]).toBe(" 1 file changed");
    expect(repo(r.state)).toMatchObject({ commitCount: 1, lastMessage: "Add README", staged: {}, clean: true });
  });

  it("only commits what was staged", () => {
    const s = sh(withCommit(), "echo one > one.txt", "echo two > two.txt", "git add one.txt", 'git commit -m "one"').state;
    expect(repo(s).branchFiles.main).toEqual({ "README.md": true, "one.txt": true });
    expect(repo(s).clean).toBe(false);
  });

  it("refuses an empty commit, a missing message and an empty message", () => {
    expect(sh(withCommit(), 'git commit -m "again"').text).toMatch(/nothing to commit, working tree clean/);
    expect(sh(withCommit(), "echo x > new.txt", 'git commit -m "x"').text).toMatch(/untracked files present/);
    expect(sh(withCommit(), "echo x >> README.md", 'git commit -m "x"').text).toMatch(/no changes added to commit/);
    expect(sh(withCommit(), "echo x >> README.md", "git add .", "git commit").errors[0]).toMatch(/git commit -m/);
    expect(sh(withCommit(), "echo x >> README.md", "git add .", 'git commit -m ""').errors[0]).toMatch(/empty commit message/);
    expect(repo(sh(withCommit(), 'git commit -m "again"').state).commitCount).toBe(1);
  });

  it("-a and -am stage tracked changes but not new files", () => {
    const s = sh(withCommit(), "echo more >> README.md", "echo n > new.txt", 'git commit -am "update"').state;
    expect(repo(s)).toMatchObject({ commitCount: 2, lastMessage: "update" });
    expect(repo(s).branchFiles.main).toEqual({ "README.md": true });
    expect(repo(sh(withCommit(), "echo more >> README.md", 'git commit -a -m "update"').state).commitCount).toBe(2);
  });

  it("log lists commits newest first, with branch decorations", () => {
    const s = sh(withCommit(), "echo 2 > two.txt", "git add .", 'git commit -m "Second"').state;
    const oneline = sh(s, "git log --oneline").out;
    expect(oneline).toHaveLength(2);
    expect(oneline[0]).toMatch(/^[0-9a-f]{7} \(HEAD -> main\) Second$/);
    expect(oneline[1]).toMatch(/^[0-9a-f]{7} Add README$/);
    expect(sh(s, "git log").text).toMatch(/^commit [0-9a-f]{7} \(HEAD -> main\)\nAuthor: learner <learner@example\.com>\n\n {4}Second\n\ncommit/);
  });

  it("log on a repository without commits is an error", () => {
    expect(sh(createLabState(), "git init project", "cd project", "git log").errors[0]).toMatch(/does not have any commits yet/);
  });

  it("gives different ids to different commits", () => {
    const s = sh(withCommit(), "echo 2 > two.txt", "git add .", 'git commit -m "Add README"').state;
    const ids = sh(s, "git log --oneline").out.map((l) => l.slice(0, 7));
    expect(new Set(ids).size).toBe(2);
  });
});

describe("branches", () => {
  it("creates, lists and switches branches with switch and checkout", () => {
    let s = sh(withCommit(), "git branch dev").state;
    expect(sh(s, "git branch").out).toEqual(["  dev", "* main"]);
    expect(sh(s, "git switch dev").text).toBe("Switched to branch 'dev'");
    s = sh(s, "git switch -c feature").state;
    expect(repo(s).branch).toBe("feature");
    s = sh(s, "git checkout main", "git checkout -b hotfix").state;
    expect(repo(s)).toMatchObject({ branch: "hotfix", branches: { main: true, dev: true, feature: true, hotfix: true } });
    expect(sh(s, "git switch hotfix").text).toBe("Already on 'hotfix'");
  });

  it("rejects duplicates, bad names, unknown branches and branching before the first commit", () => {
    const s = withCommit();
    expect(sh(s, "git branch main").errors[0]).toMatch(/already exists/);
    expect(sh(s, "git switch -c main").errors[0]).toMatch(/already exists/);
    expect(sh(s, 'git branch "bad name"').errors[0]).toMatch(/not a valid branch name/);
    expect(sh(s, "git switch nope").errors[0]).toMatch(/invalid reference: nope/);
    expect(sh(s, "git checkout nope").errors[0]).toMatch(/did not match any file/);
    expect(sh(s, "git switch").errors[0]).toMatch(/usage/);
    const unborn = sh(createLabState(), "git init project", "cd project").state;
    expect(sh(unborn, "git branch dev").errors[0]).toMatch(/not a valid object name: 'main'/);
    expect(sh(unborn, "git branch").out).toEqual([]);
    expect(repo(sh(unborn, "git switch -c trunk").state)).toMatchObject({ branch: "trunk", branches: { trunk: true } });
  });

  it("switching swaps the working tree and keeps untracked files", () => {
    let s = sh(withCommit(), "git switch -c feature", "echo n > notes.txt", "git add .", 'git commit -m "notes"', "echo scratch > scratch.txt").state;
    s = sh(s, "git switch main").state;
    expect(Object.keys(files(s)).sort()).toEqual(["~/project/README.md", "~/project/scratch.txt"]);
    s = sh(s, "git switch feature").state;
    expect(files(s)["~/project/notes.txt"]).toBe("n\n");
    expect(repo(s).branchFiles).toEqual({ main: { "README.md": true }, feature: { "README.md": true, "notes.txt": true } });
  });

  it("refuses to switch over uncommitted changes when the branches differ", () => {
    const s = sh(withCommit(), "git switch -c feature", "echo n > notes.txt", "git add .", 'git commit -m "notes"', "echo edit >> README.md").state;
    const r = sh(s, "git switch main");
    expect(r.errors[0]).toMatch(/local changes .* would be overwritten/);
    expect(repo(r.state).branch).toBe("feature");
    expect(files(r.state)["~/project/README.md"]).toBe("hello\nedit\n");
  });

  it("deletes merged branches, and unmerged ones only with -D", () => {
    const s = sh(withCommit(), "git branch merged", "git switch -c work", "echo w > w.txt", "git add .", 'git commit -m "work"', "git switch main").state;
    expect(repo(sh(s, "git branch -d merged").state).branches).toEqual({ main: true, work: true });
    expect(sh(s, "git branch -d work").errors[0]).toMatch(/not fully merged/);
    expect(repo(sh(s, "git branch -D work").state).branches).toEqual({ main: true, merged: true });
    expect(sh(s, "git branch -d main").errors[0]).toMatch(/cannot delete branch 'main'/);
    expect(sh(s, "git branch -d nope").errors[0]).toMatch(/not found/);
  });
});

describe("git merge", () => {
  const featureAhead = () =>
    sh(withCommit(), "git switch -c feature", "echo n > notes.txt", "git add .", 'git commit -m "Add notes"', "git switch main").state;

  it("fast-forwards when the current branch has no new commits", () => {
    const r = sh(featureAhead(), "git merge feature");
    expect(r.out[1]).toBe("Fast-forward");
    expect(repo(r.state)).toMatchObject({ branch: "main", commitCount: 2, clean: true });
    expect(files(r.state)["~/project/notes.txt"]).toBe("n\n");
    expect(sh(r.state, "git merge feature").text).toBe("Already up to date.");
  });

  it("creates a merge commit when both branches moved, keeping both sides' changes", () => {
    const s = sh(featureAhead(), "echo m > main-only.txt", "git add .", 'git commit -m "Main work"').state;
    const r = sh(s, "git merge feature");
    expect(r.text).toMatch(/Merge made/);
    expect(repo(r.state)).toMatchObject({ commitCount: 4, lastMessage: "Merge branch 'feature'", clean: true });
    expect(repo(r.state).branchFiles.main).toEqual({ "README.md": true, "main-only.txt": true, "notes.txt": true });
    expect(files(r.state)["~/project/notes.txt"]).toBe("n\n");
    // The other branch is untouched.
    expect(repo(r.state).branchFiles.feature).toEqual({ "README.md": true, "notes.txt": true });
  });

  it("merges a deletion made on one side", () => {
    const s = sh(withCommit(), "echo k > keep.txt", "git add .", 'git commit -m "keep"', "git switch -c cleanup", "rm README.md", "git add README.md", 'git commit -m "drop readme"', "git switch main", "echo m > m.txt", "git add .", 'git commit -m "m"').state;
    const r = sh(s, "git merge cleanup");
    expect(repo(r.state).branchFiles.main).toEqual({ "keep.txt": true, "m.txt": true });
    expect(files(r.state)["~/project/README.md"]).toBeUndefined();
  });

  it("stops on a conflict without changing anything", () => {
    const s = sh(withCommit(), "git switch -c feature", "echo theirs > README.md", 'git commit -am "theirs"', "git switch main", "echo ours > README.md", 'git commit -am "ours"').state;
    const r = sh(s, "git merge feature");
    expect(r.errors[0]).toMatch(/CONFLICT: .*README\.md/);
    expect(repo(r.state)).toMatchObject({ commitCount: 2, lastMessage: "ours", clean: true });
    expect(files(r.state)["~/project/README.md"]).toBe("ours\n");
  });

  it("refuses unknown branches and merging over uncommitted changes", () => {
    expect(sh(featureAhead(), "git merge nope").errors[0]).toMatch(/not something we can merge/);
    expect(sh(featureAhead(), "echo x >> README.md", "git merge feature").errors[0]).toMatch(/尚未提交的變更/);
    expect(sh(featureAhead(), "git merge").errors[0]).toMatch(/usage/);
  });
});

describe("git and the filesystem", () => {
  it("a moved or copied project keeps its history; a removed one loses it", () => {
    const home = sh(withCommit(), "cd ~").state;
    const moved = sh(home, "mv project app").state;
    expect(repo(moved, "~/app").commitCount).toBe(1);
    expect(repo(moved)).toBeUndefined();
    expect(sh(moved, "cd app", "git log --oneline").out).toHaveLength(1);

    const copied = sh(home, "cp -r project backup", "cd backup", "echo x > x.txt", "git add .", 'git commit -m "in copy"').state;
    expect(repo(copied, "~/backup").commitCount).toBe(2);
    expect(repo(copied).commitCount).toBe(1);

    expect(repo(sh(home, "rm -rf project").state)).toBeUndefined();
  });

  it("removing .git turns the directory back into a plain folder", () => {
    const s = sh(withCommit(), "rm -rf .git").state;
    expect(repo(s)).toBeUndefined();
    expect(sh(s, "git status").errors[0]).toMatch(/not a git repository/);
    expect(files(s)["~/project/README.md"]).toBe("hello\n");
  });

  it("a nested repository's files do not show up in the outer one", () => {
    const s = sh(createLabState(), "git init outer", "cd outer", "echo o > o.txt", "git init inner", "echo i > inner/i.txt", "git add .").state;
    expect(repo(s, "~/outer").staged).toEqual({ "o.txt": true });
  });

  it("never modifies the state it was given", () => {
    const before = withCommit();
    const snapshot = JSON.stringify(checkView(before));
    sh(before, "git switch -c x", "echo y > y.txt", "git add .", 'git commit -m "y"', "git switch main", "git merge x", "git branch -d x");
    expect(JSON.stringify(checkView(before))).toBe(snapshot);
  });
});

describe("unsupported git usage is explained", () => {
  it("remote commands, unknown subcommands and config", () => {
    const s = withCommit();
    for (const cmd of ["git push", "git pull origin main", "git clone https://example.com/x.git", "git remote -v"]) {
      expect(sh(s, cmd).errors[0], cmd).toMatch(/沒有遠端儲存庫/);
    }
    expect(sh(s, "git rebase main").errors[0]).toMatch(/不支援的指令 'rebase'/);
    expect(sh(s, "git").errors[0]).toMatch(/usage/);
    expect(sh(s, 'git config --global user.name "Me"').errors).toEqual([]);
    expect(sh(s, "git --version").text).toMatch(/git version/);
    expect(sh(s, "git log --graph").errors[0]).toMatch(/--oneline/);
  });
});

describe("git-first-commit lab", () => {
  const lab = [...loadContent().units.values()].flatMap((u) => u.labs).find((l) => l.id === "git-first-commit")!;

  function play(groups: string[][]): number[] {
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    return groups.map((commands) => {
      for (const c of commands) {
        state = execute(state, c).state;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }

  it("can be completed step by step with switch", () => {
    expect(
      play([
        ["mkdir project", "cd project", "git init"],
        ['echo "My project" > README.md', "git status", "git add README.md"],
        ['git commit -m "Add README"'],
        ["git switch -c feature"],
        ["echo todo > notes.txt", "git add notes.txt", 'git commit -m "Add notes"'],
        ["git switch main", "ls", "git merge feature", "ls"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("can be completed with checkout, git add . and commit -am style habits", () => {
    expect(
      play([
        ["git init project", "cd project"],
        ["touch README.md && git add ."],
        ['git commit -m "init"'],
        ["git checkout -b feature"],
        ["touch notes.txt", "git add -A", 'git commit -m "notes"'],
        ["git checkout main && git merge feature"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("does not pass steps done the wrong way", () => {
    // Creating the file without staging it, and committing on the wrong branch name.
    expect(play([["git init project", "cd project"], ["touch README.md"]])).toEqual([1, 1]);
    expect(play([["git init project", "cd project"], ["touch README.md", "git add ."], ['git commit -m "x"'], ["git switch -c feat"]])).toEqual([1, 2, 3, 3]);
    // Switching back to main without merging does not finish the lab.
    expect(
      play([
        ["git init project", "cd project", "touch README.md", "git add .", 'git commit -m "x"', "git switch -c feature", "touch notes.txt", "git add .", 'git commit -m "n"'],
        ["git switch main"],
      ]),
    ).toEqual([5, 5]);
  });

  it("starts with nothing complete", () => {
    expect(advance(0, createLabState(lab.initialState), lab.steps)).toBe(0);
    expect(passes(createLabState(), { type: "state", path: ["git", "~/project", "branch"], exists: true })).toBe(false);
  });
});
