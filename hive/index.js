const { manager } = require("./src/manager");
const { groupmanager } = require("./src/groupmanager");
const { taskmanager, changetask } = require("./src/statemachine");


module.exports = {
    manager,
    groupmanager,
    taskmanager,
    changetask,
};
