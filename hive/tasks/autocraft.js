const { goals } = require("mineflayer-pathfinder");
const { Movements } = require('mineflayer-pathfinder');
const { taskmanager } = require("/Users/shaurya/Documents/dev/bot/hive/statemachine.js");
const minecraftData = require('minecraft-data')
const mcData = minecraftData('1.21.1')

class autocraft extends taskmanager {
    constructor(bot) {
        super(bot);
        this.movements = undefined;
        this.data = undefined;
        this.recipie = mcData.recipes
    }

    getMats(recipe) {
		if (recipe.ingredients) {
			return recipe.ingredients;
		}
		else {
			const materialDict = {};
			//console.log(recipe);
			for (const row of recipe.inShape) {
				for (const item of row) {
					if (item.id < 0) continue;
					if (materialDictDict[item.id] === undefined) ingredientDict[item.id] = 0;
					ingredientDict[item.id] += item.count;
				}
			}
			const ingredients = Array();
			for (const i in ingredientDict) {
				ingredients.push({"id": i, "count": ingredientDict[i]});
			}
			return ingredients;
		}
	}


}